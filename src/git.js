const exec = require("just-run-it");
const retry = require("promise-retry");

const notBlank = s => /\S/.test(s);

const LINE_ENDING = /[\r\n]+/;

class Git {
    constructor(repoDir, { throttle = f => f(), gitCmd = "git" }) {
        this._dir = repoDir;
        this._throttle = throttle;
        this._gitCmd = gitCmd;
    }

    async _executeCommand(command, ...args) {
        return this._executeWithOptions(command, args);
    }

    /**
     * Commands that potentially reach out to a remote server.
     */
    async _remoteCommand(command, ...args) {
        return this._executeWithOptions(command, args, {
            withThrottle: true,
            withRetry: true
        });
    }

    async _executeWithOptions(
        command,
        args,
        { withThrottle = false, withRetry = false } = {}
    ) {
        const addRetry = withRetry
            ? f => (...args) =>
                  retry({ randomize: true, minTimeout: 100 }, retry =>
                      f(...args).catch(retry)
                  )
            : f => f;
        const doExec = addRetry(() => {
            return exec([this._gitCmd, "-C", this._dir, command, ...args], {
                capture: true,
                stdin: null,
                quiet: true
            });
        });
        const res = await (withThrottle ? this._throttle(doExec) : doExec());
        if (res.stderr && /\S/.test(res.stderr)) {
            throw new Error(
                `Error running git command ${command}: ${res.stderr}`
            );
        }
        return res.stdout;
    }

    async clone(url) {
        return this._executeCommand("clone", "--quiet", url, this._dir);
    }

    async getBranchName() {
        return this._executeCommand("symbolic-ref", "--short", "HEAD");
    }

    /**
     * Prune means to delete any refs that no longer exist on a remote.
     */
    async fetchFromAll({ prune = false } = {}) {
        const args = ["fetch", "--all", "--quiet"];
        if (prune) {
            args.push("--prune");
        }
        await this._remoteCommand(...args);
    }

    async getUncommittedChanges() {
        return (await this._executeCommand("status", "--porcelain=v1"))
            .split(LINE_ENDING)
            .filter(notBlank);
    }

    async refExists(refName) {
        try {
            return notBlank(
                await this._executeCommand("show-ref", "--", refName)
            );
        } catch (error) {
            if (
                error.code === 1 &&
                error.stderr === "" &&
                error.stdout === ""
            ) {
                return false;
            }
            throw error;
        }
    }

    async getStashes() {
        return (await this._executeCommand("stash", "list"))
            .split(LINE_ENDING)
            .filter(notBlank);
    }

    /**
     * Get a list of commits that are ancestors of `onThis` but not `butNotThis`.
     * E.g., if `onThis` is a local branch and `butNotThis` is the tracking branch,
     * it will show you any commits that haven't been pushed yet.
     */
    async getMissingCommits(onThis, butNotOnThis) {
        return (
            await this._executeCommand("rev-list", onThis, `^${butNotOnThis}`)
        )
            .split(LINE_ENDING)
            .filter(notBlank);
    }

    async init() {
        return this._executeCommand("init");
    }

    async addRemote(name, url) {
        return this._executeCommand("remote", "add", name, url);
    }

    async setTrackingBranch(branchName, remote, remoteBranch = branchName) {
        return this._executeCommand(
            "branch",
            "--set-upstream-to",
            `${remote}/${remoteBranch}`,
            branchName
        );
    }

    async createBranch(branchName, trackingBranch = null) {
        if (trackingBranch) {
            return this._executeCommand(
                "branch",
                "--track",
                branchName,
                trackingBranch
            );
        } else {
            return this._executeCommand("branch", branchName);
        }
    }

    /**
     * Check if the given branch is up to date with another branch. Branch A is up to date
     * with Branch B if and only if every commit reachable from Branch B is also reachable
     * from Branch A. This is _not_ a symmetrical relation: Branch A may be up to date with
     * Branch B even if Branch A has commits not reachable from Branch B (i.e., "is ahead of"
     * Branch B).
     */
    async isUpdateToDateWith(branch, isUpdateToDateWith) {
        return (
            (await this.getMissingCommits(isUpdateToDateWith, branch))
                .length === 0
        );
    }

    async getAllRemotes() {
        return (await this._executeCommand("remote"))
            .split(LINE_ENDING)
            .filter(notBlank);
    }

    async getRemoteUrl(remoteName) {
        return (
            await this._executeCommand("remote", "get-url", remoteName)
        ).trim();
    }

    async checkoutRemote(remoteName, branchName, localBranchName = null) {
        return this._executeCommand(
            "checkout",
            "--track",
            "-b",
            localBranchName || branchName,
            `${remoteName}/${branchName}`
        );
    }

    /**
     * Return all local branches and their configured tracking branches
     * as an array of two-tuples: [branchName, remoteRef].
     */
    async getTrackingBranches() {
        return (
            await this._executeCommand(
                "branch",
                "--format",
                "%(refname:short):%(upstream:short)"
            )
        )
            .split(LINE_ENDING)
            .filter(notBlank)
            .map(line => line.split(":"));
    }
}

module.exports = Git;
