export type SessionStatus = "waiting" | "failing" | "working" | "done" | "blocked" | "idle" | "closed";

export interface Session {
  id: string;
  cwd: string;
  project: string;
  /**
   * The repo the folder belongs to, named after its main checkout, so a worktree reads the same
   * wherever it lives (repo/.worktrees/x, repo/.claude/worktrees/x, a sibling repo-x). Null outside git.
   */
  repo: string | null;
  branch: string | null;
  /** Claude Code's AI title for the session. Set once near the start, never updated. */
  title: string | null;
  /** The name you gave it with /rename. Wins over the AI title, and only you change it. */
  customTitle: string | null;
  /** What it's working on lately, a few words from the next-action model. Changes as it goes. */
  topic: string | null;
  /** Your last few messages, newest last, for finding it again with the filter. */
  recentPrompts: string[];
  lastPrompt: string | null;
  /** Tail of Claude's last message, where the question or ask usually sits. */
  lastReply: string | null;
  /** The concrete step Claude asked the user to take, pulled from its last message. */
  nextAction: string | null;
  /** Link to open for the next action (only links found in the message or built from its PR numbers). */
  nextUrl: string | null;
  /** Exact replies Claude offered the user to type back, in the order it offered them. */
  nextSays: string[];
  /** True while the next action is still being worked out. */
  nextLoading: boolean;
  /** A Claude process for this session is running, so the operator can type a reply into it. */
  live: boolean;
  /** What the session is waiting on outside the user (CI, a deploy, a review), when status is "blocked". */
  blockedOn: string | null;
  /** Shortcut cards and PRs this session is about, with their titles. */
  refs: Ref[];
  /** URL prefixes a card or issue number is appended to, so any mention can link out. */
  refLinks: RefLinks;
  /** The main branch, when the session's branch went into it as a local merge commit (no PR). Closed sessions only. */
  mergedInto: string | null;
  status: SessionStatus;
  statusDetail: string;
  /** "operator" for the session started with `sop operator`, which runs the others. */
  role: "operator" | null;
  /** How the transcript's last turn ended, whatever the status says now. Null for hook-only sessions. */
  turnEnd: "finished" | "mid-turn" | "failing" | null;
  lastActivity: string;
}

export interface RefLinks {
  shortcut: string | null;
  github: string | null;
}

export interface Ref {
  tracker: "shortcut" | "github";
  kind: "card" | "issue" | "pr";
  id: number;
  /** How it's written in text: sc-123, #123, PR #123. */
  label: string;
  title: string;
  url: string;
  /** card: its Shortcut workflow state, lowercased (build, test, released). issue: open | closed. pr: open | draft | merged | closed. */
  state: string;
  /** "own": the session's branch card/PR. "mention": named in its messages. */
  source: "own" | "mention";
  /** How many times Claude named it in the session (recent transcript). */
  mentions: number;
}

export interface PendingDecision {
  id: string;
  sessionId: string;
  cwd: string;
  toolName: string;
  summary: string;
  toolInput: unknown;
  /** What the call is for: a Bash command's description, a Read's line range. */
  detail: string | null;
  /** Claude Code's suggested rules for "Yes, and don't ask again", sent back as-is on allow. */
  suggestions: PermissionUpdate[];
  createdAt: string;
  expiresAt: string;
}

/** One of Claude Code's permission updates (addRules, setMode, addDirectories, ...). */
export interface PermissionUpdate {
  type: string;
  rules?: { toolName: string; ruleContent?: string }[];
  behavior?: string;
  mode?: string;
  directories?: string[];
  destination?: string;
}

export interface OperatorState {
  pending: PendingDecision[];
  sessions: Session[];
}

export type Behavior = "allow" | "deny";

export interface FeedItem {
  kind: "user" | "assistant" | "tool" | "error";
  text: string;
  at: string | null;
}

/** One thing a session left behind that ending it can clean up. */
export interface CleanupItem {
  /** "pid:<n>", "worktree", "branch" or "scratch". */
  id: string;
  kind: "process" | "worktree" | "branch" | "scratch";
  label: string;
  /** Why it's safe, or why it isn't offered. */
  detail: string;
  available: boolean;
  /** Ticked when the checklist opens. */
  defaultOn: boolean;
}

export interface CleanupResult {
  id: string;
  ok: boolean;
  error?: string;
}
