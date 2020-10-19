const fs = require("fs").promises;
const path = require("path");
const yargs = require("yargs");
const Git = require("./git");
const Bottleneck = require("bottleneck");
const util = require("util");
const c = require("ansi-colors");
const mkdirp = require("mkdirp");
const buildObject = require("build-object-better");
const multimatch = require("multimatch");

async function dirExists(p) {
    try {
        return (await fs.stat(p)).isDirectory();
    } catch (error) {
        if (error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

async function pathExists(p) {
    try {
        await fs.stat(p);
        return true;
    } catch (error) {
        if (error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

async function isRepo(p) {
    return dirExists(path.join(p, ".git"));
}

const IGNORE_LIST = [".DS_Store"];

function ignoreFile(p) {
    return multimatch(p, IGNORE_LIST).length !== 0;
}

async function findRepos(p, maxDepth = Infinity) {
    if (await isRepo(p)) {
        return [path.resolve(p)];
    } else {
        let hasContents = false;
        const children = await fs.readdir(p, {
            encoding: "utf8",
            withFileTypes: true
        });

        const repos = [];
        await Promise.all(
            children.map(async dirEnt => {
                const fullPath = path.resolve(p, dirEnt.name);
                if (!ignoreFile(dirEnt.name)) {
                    if (dirEnt.isDirectory()) {
                        if (maxDepth > 1) {
                            if (isRepo(fullPath)) {
                                repos.push(fullPath);
                            } else {
                                repos.push(
                                    ...(await findRepos(fullPath, maxDepth - 1))
                                );
                            }
                        }
                    } else {
                        hasContents = true;
                    }
                }
            })
        );
        if (hasContents) {
            repos.unshift(p);
        }
        return repos;
    }
}

async function getRepoDirt(git) {
    const dirt = [];

    const uncomittedChanges = await git.getUncommittedChanges();
    if (uncomittedChanges.length) {
        dirt.push(["uncomitted changes", { changes: uncomittedChanges }]);
    }

    const stashes = await git.getStashes();
    if (stashes.length) {
        dirt.push(["stashes", { stashes }]);
    }

    const branches = (
        await Promise.all(
            (await git.getTrackingBranches()).map(
                async ([branchName, remote]) => {
                    const isMerged =
                        (await git.isUpdateToDateWith(
                            "origin/master",
                            branchName
                        )) ||
                        (await git.isUpdateToDateWith("master", branchName));
                    return [isMerged, branchName, remote];
                }
            )
        )
    )
        .filter(([isMerged]) => !isMerged)
        .map(([, branch, target]) => [branch, target]);
    const trackedBranches = branches.filter(([, remote]) => remote !== "");
    const untrackedBranches = branches.filter(([, remote]) => remote === "");

    if (untrackedBranches.length) {
        dirt.push([
            "untracked branches",
            { branches: untrackedBranches.map(([branch]) => branch) }
        ]);
    }

    const notTrackedToOrigin = branches.filter(
        ([, remote]) => remote && !/^origin\//.test(remote)
    );
    if (notTrackedToOrigin.length) {
        dirt.push([
            "branches not tracked to origin",
            {
                branches: notTrackedToOrigin
            }
        ]);
    }

    const branchesAndUnpushedCommits = (
        await Promise.all(
            trackedBranches.map(async ([branch, remote]) => {
                const targetBranch = (await git.refExists(remote))
                    ? remote
                    : "master";
                const commits = await git.getMissingCommits(
                    branch,
                    targetBranch
                );
                return { branch, remote, commits };
            })
        )
    ).filter(({ commits }) => commits.length);
    // FIXME: In some cases, the remote has been deleted because it's already merged to master.
    if (branchesAndUnpushedCommits.length) {
        dirt.push([
            "unpushed commits",
            { dirtyBranches: branchesAndUnpushedCommits }
        ]);
    }

    if (dirt.length) {
        return dirt;
    }
    // intentional return undefined.
}

async function getRepoSetup(git) {
    const remotes = await Promise.all(
        (await git.getAllRemotes()).map(async remote => ({
            remote,
            url: await git.getRemoteUrl(remote)
        }))
    );

    const trackedBranches = (await git.getTrackingBranches())
        .filter(([, remote]) => remote)
        .map(([branch, trackingBranch]) => ({
            branch,
            trackingBranch
        }));

    return {
        remotes: buildObject(
            remotes,
            rm => rm.remote,
            (k, idx, ks, rm) => rm.url
        ),
        branches: buildObject(
            trackedBranches,
            br => br.branch,
            (k, i, ks, br) => br.trackingBranch
        )
    };
}

async function checkRepo(repo, gitThrottle) {
    try {
        if (await isRepo(repo)) {
            const git = new Git(repo, { throttle: gitThrottle });
            await git.fetchFromAll({ prune: true });
            const dirt = await getRepoDirt(git);
            return { repo, setup: await getRepoSetup(git), dirt };
        } else {
            const children = await fs.readdir(repo, {
                encoding: "utf8",
                withFileTypes: true
            });

            const contents = (
                await Promise.all(
                    children.map(async dirEnt => {
                        const isContents =
                            !ignoreFile(dirEnt.name) && !dirEnt.isDirectory();
                        return [dirEnt.name, isContents];
                    })
                )
            )
                .filter(([, isContents]) => isContents)
                .map(([name]) => name);
            return { repo, dirt: [["not a repo", { contents }]] };
        }
    } catch (error) {
        return { repo, error };
    }
}

async function readScanFile(scanFile) {
    const contents = await fs.readFile(scanFile, "utf8");
    const report = JSON.parse(contents);
    return report;
}

async function getFailedReposAndResultsObject(scanFile) {
    const report = await readScanFile(scanFile);
    const failedRepos = Object.entries(report.repos)
        .filter(([, { dirt, error }]) => error || (dirt && dirt.length))
        .map(([repo]) => repo);
    const reposExist = await Promise.all(
        failedRepos.map(async dir => [await dirExists(dir), dir])
    );
    const existingFailedRepos = reposExist
        .filter(([exists]) => exists)
        .map(([, repo]) => repo);

    const missingFailedRepos = reposExist
        .filter(([exists]) => !exists)
        .map(([, repo]) => repo);
    missingFailedRepos.forEach(repo => {
        delete report.repos[repo];
    });
    return [existingFailedRepos, report];
}

async function getReposAndResultsObject(args) {
    const [command] = args._;
    switch (command) {
        case "scan":
            return [
                await findRepos(
                    args.directory,
                    args.recurse || args["max-depth"] <= 0
                        ? Infinity
                        : args["max-depth"]
                ),
                {
                    repos: {},
                    summary: { rootDir: path.resolve(args.directory) }
                }
            ];

        case "update":
            return getFailedReposAndResultsObject(args["scan-file"]);

        default:
            throw new Error(`Unhandled command: ${command}`);
    }
}

async function runSetup(args) {
    const report = await readScanFile(args["scan-file"]);
    const originalRootDir = report.summary.rootDir;
    const newRootDir = args.root || originalRootDir;
    const repoOperations = (
        await Promise.all(
            Object.entries(report.repos).map(
                async ([originalPath, repoReport]) => {
                    if (!originalPath.startsWith(`${originalRootDir}/`)) {
                        throw new Error(
                            `Repo ${originalPath} does not begin with specified root: ${originalRootDir}`
                        );
                    }
                    if (
                        repoReport.error ||
                        (repoReport.dirt && repoReport.dirt.length)
                    ) {
                        if (args["ignore-failed"]) {
                            return null;
                        }
                        throw new Error(
                            `Repo ${originalPath} has failures or is not clean`
                        );
                    }
                    const relPath = originalPath.substr(
                        originalRootDir.length + 1
                    );
                    const newPath = path.join(newRootDir, relPath);
                    if (await pathExists(newPath)) {
                        throw new Error(
                            `The target destination path already exists: ${newPath}`
                        );
                    }

                    const masterBranch = repoReport.setup.branches.master;
                    if (!masterBranch) {
                        throw new Error(
                            `The repo has no master branch specified: ${originalPath}`
                        );
                    }
                    const [
                        masterRemoteName,
                        ...masterRemoteBranchNames
                    ] = masterBranch.split("/");
                    const masterRemote =
                        repoReport.setup.remotes[masterRemoteName];
                    if (!masterRemote) {
                        throw new Error(
                            `The master branch is tracking an unknown remote '${masterRemote}': ${originalPath}`
                        );
                    }

                    return {
                        path: newPath,
                        source: masterRemote,
                        masterRemoteName,
                        masterRemoteBranch: masterRemoteBranchNames.join("/"),
                        setup: repoReport.setup
                    };
                }
            )
        )
    ).filter(op => op !== null);

    const throttle = createThrottle(args);
    await Promise.all(
        repoOperations.map(async op => {
            await mkdirp(op.path);
            const git = new Git(op.path, { throttle });

            await git.clone(op.source);
            await Object.entries(op.setup.remotes).reduce(
                async (p, [remote, url]) => {
                    await p;
                    if (remote !== op.masterRemoteName) {
                        await git.addRemote(remote, url);
                    }
                },
                Promise.resolve()
            );

            await git.fetchFromAll();
            await git.setTrackingBranch(
                "master",
                op.masterRemoteName,
                op.masterRemoteBranch
            );

            await Object.entries(op.setup.branches).reduce(
                async (p, [branch, trackingBranch]) => {
                    await p;
                    if (
                        branch !== "master" &&
                        (await git.refExists(trackingBranch))
                    ) {
                        await git.createBranch(branch, trackingBranch);
                    }
                },
                Promise.resolve()
            );
            console.log(`✔️ ${c.green(op.path)}`);
        })
    );
}

async function main(args) {
    const [command] = args._;
    switch (command) {
        case "scan":
        case "update":
            return runScanOrUpdate(args);

        case "setup":
            return runSetup(args);

        default:
            throw new Error(`Unhandled command: ${command}`);
    }
}

function createThrottle(args) {
    const bottleneck = new Bottleneck({
        maxConcurrent: 1,
        minTime: args["min-time"]
    });
    const throttle = f => bottleneck.schedule(f);
    return throttle;
}

async function runScanOrUpdate(args) {
    const [repos, report] = await getReposAndResultsObject(args);
    const throttle = createThrottle(args);
    const repoResults = await Promise.all(
        repos.map(async repo => {
            const res = await checkRepo(repo, throttle);
            const failed = res.error || (res.dirt && res.dirt.length);
            if (failed) {
                console.log(`❌ ${c.red(repo)}`);
            } else {
                console.log(`✔️ ${c.green(repo)}`);
            }
            return res;
        })
    );

    repoResults.forEach(({ repo, ...props }) => {
        report.repos[repo] = props;
    });
    const failures = repoResults.filter(
        ({ error, dirt }) => error || (dirt && dirt.length)
    );
    report.summary.counts = {
        reposFound: repos.length,
        cleanRepos: repos.length - failures.length,
        uncleanRepos: failures.length
    };
    const reportStr =
        args.output || args.json
            ? JSON.stringify(report, null, 4)
            : util.inspect(report, {
                  depth: Infinity,
                  colors: true
              });
    if (args.output) {
        await fs.writeFile(args.output, reportStr, "utf8");
    } else {
        console.log(reportStr);
    }
}

async function enter() {
    const args = yargs
        .command(
            "scan [directory]",
            "Scan the specified directory recursively for git repositories",
            _y =>
                _y
                    .positional("directory", {
                        default: ".",
                        type: "string",
                        description: "The path to the directory to scan"
                    })
                    .option("output", {
                        alias: "o",
                        type: "string",
                        describe:
                            "Path to an output file where the results will be written."
                    })
                    .option("recurse", {
                        alias: ["r", "recursive"],
                        type: "boolean",
                        conflicts: "max-depth",
                        describe: "An alias for setting --max-depth to infinity"
                    })
                    .option("max-depth", {
                        description:
                            "Set the maximum depth to recurse through the given directory looking for repositories. Set to 0 for infinite depth (same as using --recurse)",
                        conflicts: "recurse",
                        type: "number",
                        default: Infinity
                    })
                    .option("json", {
                        type: "boolean",
                        describe:
                            "Output in pure JSON, rather than Node's inspect format. If --output is specified, this is implied and should not be set.",
                        conflicts: "output"
                    })
                    .option("min-time", {
                        type: "number",
                        default: 334,
                        describe:
                            "The minimum time, in milliseconds, between requests to a remote server"
                    })
                    .strict()
        )
        .command(
            "update <scan-file>",
            "Given a results file from a previous run, recheck any that has previously ailed or come up as being dirty",
            _y =>
                _y
                    .positional("scan-file", {
                        describe:
                            "The path to a JSON file previously output by the scan or update command"
                    })
                    .option("output", {
                        alias: "o",
                        type: "string",
                        describe:
                            "Path to an output file where the results will be written."
                    })
                    .option("json", {
                        type: "boolean",
                        describe:
                            "Output in pure JSON, rather than Node's inspect format. If --output is specified, this is implied and should not be set.",
                        conflicts: "output"
                    })
                    .option("min-time", {
                        type: "number",
                        default: 334,
                        describe:
                            "The minimum time, in milliseconds, between requests to a remote server"
                    })
                    .strict()
        )
        .command(
            "setup <scan-file>",
            "Using a scan file, setup the same local repositories in a new directory (e.g., on a new system)",
            _y =>
                _y
                    .positional("scan-file", {
                        describe:
                            "The path to a JSON file previously output by the scan or update command"
                    })
                    .option("root", {
                        alias: "r",
                        description:
                            "Specify the root directory for the new setup."
                    })
                    .option("ignore-failed", {
                        type: "boolean",
                        description:
                            "Normally a scan-file with failures or dirty repos will not be processed and will cause a failure, unless you pass this option."
                    })
                    .option("min-time", {
                        type: "number",
                        default: 334,
                        describe:
                            "The minimum time, in milliseconds, between requests to a remote server"
                    })
                    .strict()
        )
        .option("debug", {
            type: "boolean",
            default: false,
            hidden: true
        })
        .strict().argv;

    try {
        await main(args);
    } catch (error) {
        if (args.debug) {
            console.error(error);
        } else {
            console.error(`Error: ${error.message}`);
        }
        process.exitCode = 1;
    }
}

enter();
