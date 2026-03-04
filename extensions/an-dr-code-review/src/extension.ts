import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';

// ── Data model ─────────────────────────────────────────────────────────────────

interface StoredComment {
    id: string;
    author?: string;
    body: string;
    timestamp: string;
}

interface StoredThread {
    id: string;
    file: string;
    line: number;
    endLine: number;
    resolved: boolean;
    comments: StoredComment[];
}

interface ReviewData {
    version: number;
    threads: StoredThread[];
}

// ── ReviewComment ──────────────────────────────────────────────────────────────

class ReviewComment implements vscode.Comment {
    id: string;
    body: vscode.MarkdownString;
    mode = vscode.CommentMode.Preview;
    author: vscode.CommentAuthorInformation;
    timestamp: Date;
    contextValue = 'reviewComment';

    constructor(stored: StoredComment) {
        this.id = stored.id;
        this.body = new vscode.MarkdownString(stored.body);
        this.author = { name: stored.author ?? '' };
        this.timestamp = new Date(stored.timestamp);
    }
}

// ── Storage ────────────────────────────────────────────────────────────────────

function getDataFilePath(): string | null {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return null;
    const cfg = vscode.workspace.getConfiguration('codeReview');
    return path.join(root, cfg.get<string>('dataFile', '.code-review.json'));
}

function loadData(): ReviewData {
    const fp = getDataFilePath();
    if (!fp || !fs.existsSync(fp)) return { version: 1, threads: [] };
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')) as ReviewData; }
    catch { return { version: 1, threads: [] }; }
}

function saveData(data: ReviewData): void {
    const fp = getDataFilePath();
    if (fp) fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getAuthor(): string {
    const cfg = vscode.workspace.getConfiguration('codeReview');
    const val = cfg.get<string>('author', '').trim();
    if (val) return val;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) {
        try {
            return execSync('git config user.name', {
                cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
        } catch { /* fall through */ }
    }
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
}

function gitExec(cmd: string): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return '';
    try {
        return execSync(cmd, {
            cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch { return ''; }
}

function buildFileUrl(file: string, startLine: number, endLine: number): string | null {
    const remote = gitExec('git remote get-url origin');
    if (!remote) return null;

    let base: string;
    const ssh = remote.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
    if (ssh) {
        base = `https://${ssh[1]}/${ssh[2]}`;
    } else {
        const https = remote.match(/^https?:\/\/(?:[^@]+@)?(.+?)(?:\.git)?$/);
        if (!https) return null;
        base = `https://${https[1]}`;
    }

    const branch = gitExec('git rev-parse --abbrev-ref HEAD') || 'main';
    // GitLab uses #L1-5, GitHub uses #L1-L5
    const isGitLab = base.includes('gitlab');
    const anchor = isGitLab
        ? `#L${startLine + 1}-${endLine + 1}`
        : `#L${startLine + 1}-L${endLine + 1}`;
    return `${base}/blob/${branch}/${file}${anchor}`;
}

// ── Markdown export ────────────────────────────────────────────────────────────

async function exportMarkdown(data: ReviewData): Promise<void> {
    if (data.threads.length === 0) {
        vscode.window.showInformationMessage('Code Review: no comments to export.');
        return;
    }

    const byFile = new Map<string, StoredThread[]>();
    for (const t of data.threads) {
        if (!byFile.has(t.file)) byFile.set(t.file, []);
        byFile.get(t.file)!.push(t);
    }

    const lines: string[] = [
        '# Code Review', '',
        `*Exported: ${new Date().toISOString().split('T')[0]}*`, '',
    ];

    for (const [file, threads] of byFile) {
        lines.push(`## \`${file}\``, '');
        for (const t of threads.sort((a, b) => a.line - b.line)) {
            const s = t.line + 1;
            const e = t.endLine + 1;
            const lineLabel = s === e ? `Line ${s}` : `Lines ${s}–${e}`;
            const url = buildFileUrl(t.file, t.line, t.endLine);
            const linkPart = url ? ` · [View online](${url})` : '';
            const resolvedPart = t.resolved ? ' ✅' : '';
            lines.push(`### ${lineLabel}${resolvedPart}${linkPart}`, '');
            for (const c of t.comments) {
                const date = new Date(c.timestamp).toLocaleString();
                const meta = c.author ? `**${c.author}** · *${date}*` : `*${date}*`;
                lines.push(meta, '', c.body, '');
            }
            lines.push('---', '');
        }
    }

    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const outPath = path.join(root, 'code-review.md');
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    const doc = await vscode.workspace.openTextDocument(outPath);
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(`Code review exported to ${path.basename(outPath)}`);
}

// ── Activate ───────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    const ctrl = vscode.comments.createCommentController('an-dr-code-review', 'Code Review');
    context.subscriptions.push(ctrl);

    // Show the gutter '+' button on all lines of all files
    ctrl.commentingRangeProvider = {
        provideCommentingRanges(doc) {
            return [new vscode.Range(0, 0, doc.lineCount - 1, 0)];
        },
    };

    // Maps VS Code CommentThread ↔ stored thread ID.
    // WeakMap lets disposed threads be garbage-collected automatically.
    const threadToId = new WeakMap<vscode.CommentThread, string>();
    const idToThread = new Map<string, vscode.CommentThread>();

    // ── Restore threads from JSON on startup ───────────────────────────────────

    function restoreThreads(): void {
        for (const t of idToThread.values()) t.dispose();
        idToThread.clear();

        const data = loadData();
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) return;

        for (const stored of data.threads) {
            const uri = vscode.Uri.file(path.join(root, stored.file));
            const range = new vscode.Range(stored.line, 0, stored.endLine, 0);
            const comments = stored.comments.map(c => new ReviewComment(c));
            const thread = ctrl.createCommentThread(uri, range, comments);
            thread.label = 'Code Review';
            thread.canReply = true;
            thread.contextValue = stored.resolved ? 'resolved' : 'unresolved';
            thread.collapsibleState = stored.resolved
                ? vscode.CommentThreadCollapsibleState.Collapsed
                : vscode.CommentThreadCollapsibleState.Expanded;

            threadToId.set(thread, stored.id);
            idToThread.set(stored.id, thread);
        }
    }

    restoreThreads();

    // ── Submit new comment or reply ────────────────────────────────────────────

    function handleSubmit(reply: vscode.CommentReply): void {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) return;
        const body = reply.text.trim();
        if (!body) return;

        const data = loadData();
        const relFile = path.relative(root, reply.thread.uri.fsPath).replace(/\\/g, '/');
        const range = reply.thread.range;
        if (!range) return;

        let threadId = threadToId.get(reply.thread);
        let stored = threadId ? data.threads.find(t => t.id === threadId) : undefined;

        if (!stored) {
            // First comment in a brand-new thread created by clicking '+'
            threadId = randomUUID();
            stored = {
                id: threadId,
                file: relFile,
                line: range.start.line,
                endLine: range.end.line,
                resolved: false,
                comments: [],
            };
            data.threads.push(stored);
            threadToId.set(reply.thread, threadId);
            idToThread.set(threadId, reply.thread);
            reply.thread.label = 'Code Review';
            reply.thread.canReply = true;
            reply.thread.contextValue = 'unresolved';
        }

        const cfg = vscode.workspace.getConfiguration('codeReview');
        const newComment: StoredComment = {
            id: randomUUID(),
            ...(cfg.get<boolean>('showAuthor', false) && { author: getAuthor() }),
            body,
            timestamp: new Date().toISOString(),
        };
        stored.comments.push(newComment);
        saveData(data);

        reply.thread.comments = [...reply.thread.comments, new ReviewComment(newComment)];
        reply.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }

    // ── Delete a single comment ────────────────────────────────────────────────

    function handleDeleteComment(comment: ReviewComment): void {
        const data = loadData();
        for (const stored of data.threads) {
            const idx = stored.comments.findIndex(c => c.id === comment.id);
            if (idx === -1) continue;

            stored.comments.splice(idx, 1);
            const thread = idToThread.get(stored.id);
            if (thread) {
                thread.comments = thread.comments.filter(
                    c => (c as ReviewComment).id !== comment.id,
                );
                if (thread.comments.length === 0) {
                    // Thread is now empty — remove it entirely
                    data.threads.splice(data.threads.indexOf(stored), 1);
                    idToThread.delete(stored.id);
                    thread.dispose();
                }
            }
            saveData(data);
            return;
        }
    }

    // ── Resolve / Unresolve thread ─────────────────────────────────────────────

    function setResolved(thread: vscode.CommentThread, resolved: boolean): void {
        const threadId = threadToId.get(thread);
        if (!threadId) return;
        const data = loadData();
        const stored = data.threads.find(t => t.id === threadId);
        if (!stored) return;
        stored.resolved = resolved;
        saveData(data);
        thread.contextValue = resolved ? 'resolved' : 'unresolved';
        thread.collapsibleState = resolved
            ? vscode.CommentThreadCollapsibleState.Collapsed
            : vscode.CommentThreadCollapsibleState.Expanded;
    }

    // ── Delete entire thread ───────────────────────────────────────────────────

    function handleDeleteThread(thread: vscode.CommentThread): void {
        const threadId = threadToId.get(thread);
        if (threadId) {
            const data = loadData();
            const idx = data.threads.findIndex(t => t.id === threadId);
            if (idx !== -1) data.threads.splice(idx, 1);
            saveData(data);
            idToThread.delete(threadId);
        }
        thread.dispose();
    }

    // ── Register commands ──────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('an-dr-code-review.submitComment',
            (reply: vscode.CommentReply) => handleSubmit(reply)),
        vscode.commands.registerCommand('an-dr-code-review.deleteComment',
            (comment: ReviewComment) => handleDeleteComment(comment)),
        vscode.commands.registerCommand('an-dr-code-review.resolveThread',
            (thread: vscode.CommentThread) => setResolved(thread, true)),
        vscode.commands.registerCommand('an-dr-code-review.unresolveThread',
            (thread: vscode.CommentThread) => setResolved(thread, false)),
        vscode.commands.registerCommand('an-dr-code-review.deleteThread',
            (thread: vscode.CommentThread) => handleDeleteThread(thread)),
        vscode.commands.registerCommand('an-dr-code-review.exportMarkdown',
            () => exportMarkdown(loadData())),
    );
}

export function deactivate(): void { /* nothing to clean up */ }
