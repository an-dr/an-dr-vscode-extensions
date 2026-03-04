import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawn } from 'child_process';

// ── Types ─────────────────────────────────────────────────────────────────────

type Platform = 'win32' | 'darwin' | 'linux';

/** How the tool is invoked with a repo path */
type InvokeMode =
    | { type: 'arg'; prefix?: string[] }  // exec [prefix...] <repoPath>
    | { type: 'cwd'; args?: string[] };   // exec [args...] with cwd=repoPath

interface ToolDef {
    id: string;
    name: string;
    /** Executable name to search in PATH (per-platform or single string). */
    exeName: Partial<Record<Platform, string>> | string;
    /** Fixed paths to try per platform. Supports %ENV_VAR% / $ENV_VAR expansion. */
    fixedPaths: Partial<Record<Platform, string[]>>;
    /** Directories to search when fixed paths miss (finds first matching exeName inside). */
    searchDirs: Partial<Record<Platform, string[]>>;
    invoke: InvokeMode;
}

// ── Tool registry ─────────────────────────────────────────────────────────────

const TOOLS: ToolDef[] = [
    {
        id: 'smartgit',
        name: 'SmartGit',
        exeName: { win32: 'smartgit.exe', darwin: 'SmartGit', linux: 'smartgit' },
        fixedPaths: {
            win32: [
                '%ProgramFiles%\\SmartGit\\bin\\smartgit.exe',
                '%ProgramFiles(x86)%\\SmartGit\\bin\\smartgit.exe',
            ],
            darwin: ['/Applications/SmartGit.app/Contents/MacOS/SmartGit'],
            linux: [
                '$HOME/.local/smartgit/bin/smartgit.sh',
                '/usr/lib/smartgit/bin/smartgit.sh',
                '/opt/smartgit/bin/smartgit.sh',
                '/usr/local/bin/smartgit',
            ],
        },
        searchDirs: {},
        invoke: { type: 'arg' },
    },
    {
        id: 'gitkraken',
        name: 'GitKraken',
        exeName: { win32: 'gitkraken.exe', darwin: 'GitKraken', linux: 'gitkraken' },
        fixedPaths: {
            win32: ['%ProgramFiles%\\Axosoft\\GitKraken\\gitkraken.exe'],
            darwin: ['/Applications/GitKraken.app/Contents/MacOS/GitKraken'],
            linux: ['/usr/bin/gitkraken', '/snap/bin/gitkraken'],
        },
        searchDirs: {
            // Versioned install dirs like %LOCALAPPDATA%\gitkraken\app-10.3.0\gitkraken.exe
            win32: ['%LOCALAPPDATA%\\gitkraken'],
            linux: ['%HOME%/.local/share/gitkraken'],
        },
        invoke: { type: 'arg', prefix: ['-p'] },
    },
    {
        id: 'sourcetree',
        name: 'SourceTree',
        exeName: { win32: 'SourceTree.exe', darwin: 'stree' },
        fixedPaths: {
            win32: [
                '%LOCALAPPDATA%\\SourceTree\\SourceTree.exe',
                '%ProgramFiles%\\Atlassian\\SourceTree\\SourceTree.exe',
            ],
            darwin: ['/Applications/Sourcetree.app/Contents/MacOS/Sourcetree'],
        },
        searchDirs: {},
        invoke: { type: 'arg' },
    },
    {
        id: 'fork',
        name: 'Fork',
        exeName: { win32: 'Fork.exe', darwin: 'fork' },
        fixedPaths: {
            win32: [
                '%LOCALAPPDATA%\\Fork\\Fork.exe',
                '%ProgramFiles%\\Fork\\Fork.exe',
            ],
            darwin: ['/Applications/Fork.app/Contents/MacOS/Fork'],
        },
        searchDirs: {},
        invoke: { type: 'arg' },
    },
    {
        id: 'tower',
        name: 'Tower',
        // Tower installs a CLI called 'gittower'
        exeName: { win32: 'gittower.exe', darwin: 'gittower' },
        fixedPaths: {
            win32: ['%ProgramFiles%\\fournova\\Tower\\tower.exe'],
            darwin: [
                '/Applications/Tower.app/Contents/MacOS/Tower',
                '/usr/local/bin/gittower',
            ],
        },
        searchDirs: {},
        invoke: { type: 'arg' },
    },
    {
        id: 'github-desktop',
        name: 'GitHub Desktop',
        exeName: { win32: 'GitHubDesktop.exe', darwin: 'github', linux: 'github-desktop' },
        fixedPaths: {
            darwin: ['/Applications/GitHub Desktop.app/Contents/MacOS/GitHub Desktop'],
            linux: ['/usr/bin/github-desktop', '/snap/bin/github-desktop'],
        },
        searchDirs: {
            win32: ['%LOCALAPPDATA%\\GitHubDesktop'],
        },
        invoke: { type: 'arg' },
    },
    {
        id: 'sublime-merge',
        name: 'Sublime Merge',
        exeName: { win32: 'smerge.exe', darwin: 'smerge', linux: 'smerge' },
        fixedPaths: {
            win32: [
                '%ProgramFiles%\\Sublime Merge\\smerge.exe',
                '%APPDATA%\\Sublime Merge\\smerge.exe',
            ],
            darwin: [
                '/Applications/Sublime Merge.app/Contents/SharedSupport/bin/smerge',
                '/usr/local/bin/smerge',
            ],
            linux: ['/usr/bin/smerge', '/opt/sublime_merge/sublime_merge'],
        },
        searchDirs: {},
        invoke: { type: 'arg' },
    },
    {
        id: 'gitextensions',
        name: 'Git Extensions',
        exeName: { win32: 'GitExtensions.exe', linux: 'gitextensions' },
        fixedPaths: {
            win32: [
                '%ProgramFiles%\\GitExtensions\\GitExtensions.exe',
                '%ProgramFiles(x86)%\\GitExtensions\\GitExtensions.exe',
            ],
            linux: ['/usr/bin/gitextensions'],
        },
        searchDirs: {},
        // 'browse <path>' opens the repo view
        invoke: { type: 'arg', prefix: ['browse'] },
    },
    {
        id: 'gitk',
        name: 'gitk',
        exeName: 'gitk',
        fixedPaths: {
            win32: [
                '%ProgramFiles%\\Git\\bin\\gitk',
                '%ProgramFiles%\\Git\\cmd\\gitk',
                '%ProgramFiles(x86)%\\Git\\bin\\gitk',
            ],
        },
        searchDirs: {},
        invoke: { type: 'cwd', args: ['--all'] },
    },
    {
        id: 'git-gui',
        name: 'git gui',
        exeName: 'git',
        fixedPaths: {},
        searchDirs: {},
        invoke: { type: 'cwd', args: ['gui'] },
    },
];

// ── Path resolution ───────────────────────────────────────────────────────────

function expandEnv(p: string): string {
    if (process.platform === 'win32') {
        return p.replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? `%${k}%`);
    }
    return p.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, k) => process.env[k] ?? '');
}

function fileExists(p: string): boolean {
    try { return fs.existsSync(p); } catch { return false; }
}

function whichSync(name: string): string | null {
    try {
        const cmd = process.platform === 'win32' ? `where "${name}"` : `which "${name}"`;
        const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return out.split('\n')[0].trim() || null;
    } catch {
        return null;
    }
}

/** Recursively search `dir` for a file named `exeName`, up to `maxDepth` levels.
 *  Subdirectory names are sorted descending so newer versioned dirs (e.g. app-10.x) are tried first. */
function findInDir(dir: string, exeName: string, maxDepth = 3): string | null {
    if (!fileExists(dir)) return null;

    function search(cur: string, depth: number): string | null {
        if (depth < 0) return null;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return null; }

        for (const e of entries) {
            if (e.isFile() && e.name.toLowerCase() === exeName.toLowerCase()) {
                return path.join(cur, e.name);
            }
        }
        const subdirs = entries
            .filter(e => e.isDirectory())
            .sort((a, b) => b.name.localeCompare(a.name)); // descending → newest version first
        for (const e of subdirs) {
            const found = search(path.join(cur, e.name), depth - 1);
            if (found) return found;
        }
        return null;
    }

    return search(dir, maxDepth);
}

function resolveTool(def: ToolDef, customPath?: string): string | null {
    // 0. User-supplied path takes absolute precedence
    if (customPath) {
        return fileExists(customPath) ? customPath : null;
    }

    const plat = process.platform as Platform;
    const exeName = typeof def.exeName === 'string' ? def.exeName : (def.exeName[plat] ?? '');

    // 1. Check PATH
    if (exeName) {
        const found = whichSync(exeName);
        if (found) return found;
    }

    // 2. Fixed install paths
    for (const raw of def.fixedPaths[plat] ?? []) {
        const p = expandEnv(raw);
        if (fileExists(p)) return p;
    }

    // 3. Search inside known directories (handles versioned installs)
    if (exeName) {
        for (const rawDir of def.searchDirs[plat] ?? []) {
            const found = findInDir(expandEnv(rawDir), exeName);
            if (found) return found;
        }
    }

    return null;
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function execGit(args: string, cwd: string): string {
    try {
        return execSync(`git ${args}`, {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return '';
    }
}

function getGitRoot(filePath: string): string {
    return execGit('rev-parse --show-toplevel', path.dirname(filePath));
}

// ── Launch ────────────────────────────────────────────────────────────────────

async function launchTool(repoPath: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('gitTool');
    const toolId = config.get<string>('tool', 'smartgit');
    const customPath = config.get<string>('toolPath', '').trim();

    const def = TOOLS.find(t => t.id === toolId);
    if (!def) {
        vscode.window.showErrorMessage(`an-dr Git Tool: unknown tool "${toolId}".`);
        return;
    }

    const exe = resolveTool(def, customPath || undefined);
    if (!exe) {
        vscode.window.showErrorMessage(
            `an-dr Git Tool: ${def.name} not found. ` +
            `Install it or set "gitTool.toolPath" to the executable path.`
        );
        return;
    }

    const { invoke } = def;
    const spawnArgs = invoke.type === 'arg'
        ? [...(invoke.prefix ?? []), repoPath]
        : (invoke.args ?? []);
    const spawnOpts: import('child_process').SpawnOptions = {
        cwd: invoke.type === 'cwd' ? repoPath : undefined,
        detached: true,
        stdio: 'ignore',
    };

    const child = spawn(exe, spawnArgs, spawnOpts);
    child.unref();
}

// ── Status bar ────────────────────────────────────────────────────────────────

function createStatusBarItem(config: vscode.WorkspaceConfiguration): vscode.StatusBarItem {
    const alignment = config.get<string>('statusBarAlignment', 'right') === 'left'
        ? vscode.StatusBarAlignment.Left
        : vscode.StatusBarAlignment.Right;
    const priority = config.get<number>('statusBarPriority', 99);
    return vscode.window.createStatusBarItem(alignment, priority);
}

function updateStatusBar(item: vscode.StatusBarItem, config: vscode.WorkspaceConfiguration): void {
    if (!config.get<boolean>('showStatusBar', true)) { item.hide(); return; }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.isUntitled || editor.document.uri.scheme !== 'file') {
        item.hide();
        return;
    }

    const gitRoot = getGitRoot(editor.document.uri.fsPath);
    if (!gitRoot) { item.hide(); return; }

    const toolId = config.get<string>('tool', 'smartgit');
    const toolName = TOOLS.find(t => t.id === toolId)?.name ?? toolId;
    const iconOnly = config.get<boolean>('statusBarIconOnly', false);

    item.text = iconOnly ? '$(source-control)' : `$(source-control) ${toolName}`;
    item.tooltip = `Open repo in ${toolName}`;
    item.command = 'an-dr-git-tool.openInGitTool';
    item.show();
}

// ── Activate ──────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    const config = () => vscode.workspace.getConfiguration('gitTool');

    let statusBar = createStatusBarItem(config());
    context.subscriptions.push(statusBar);

    const refresh = () => updateStatusBar(statusBar, config());

    context.subscriptions.push(
        vscode.commands.registerCommand('an-dr-git-tool.openInGitTool', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.isUntitled || editor.document.uri.scheme !== 'file') {
                vscode.window.showErrorMessage('an-dr Git Tool: no active file.');
                return;
            }
            const gitRoot = getGitRoot(editor.document.uri.fsPath);
            if (!gitRoot) {
                vscode.window.showErrorMessage('an-dr Git Tool: file is not inside a git repo.');
                return;
            }
            await launchTool(gitRoot);
        }),

        vscode.window.onDidChangeActiveTextEditor(refresh),

        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('gitTool')) {
                const needsRecreate =
                    e.affectsConfiguration('gitTool.statusBarAlignment') ||
                    e.affectsConfiguration('gitTool.statusBarPriority');
                if (needsRecreate) {
                    statusBar.dispose();
                    statusBar = createStatusBarItem(config());
                    context.subscriptions.push(statusBar);
                }
                refresh();
            }
        })
    );

    refresh();
}

export function deactivate(): void { /* nothing to clean up */ }
