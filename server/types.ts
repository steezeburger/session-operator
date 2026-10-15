export type SessionStatus = "waiting" | "failing" | "working" | "done" | "blocked" | "idle" | "closed";

export interface Session {
  id: string;
  cwd: string;
  project: string;
  branch: string | null;
  title: string | null;
  lastPrompt: string | null;
  /** Tail of Claude's last message, where the question or ask usually sits. */
  lastReply: string | null;
  /** The concrete step Claude asked Jesse to take, pulled from its last message. */
  nextAction: string | null;
  /** Link to open for the next action (only links found in the message or built from its PR numbers). */
  nextUrl: string | null;
  /** Exact text Claude asked Jesse to type back. */
  nextSay: string | null;
  /** True while the next action is still being worked out. */
  nextLoading: boolean;
  /** A Claude process for this session is running, so the operator can type a reply into it. */
  live: boolean;
  /** What the session is waiting on outside Jesse (CI, a deploy, a review), when status is "blocked". */
  blockedOn: string | null;
  /** Shortcut cards and PRs this session is about, with their titles. */
  refs: Ref[];
  status: SessionStatus;
  statusDetail: string;
  /** "operator" for the session started with `sop operator`, which runs the others. */
  role: "operator" | null;
  /** How the transcript's last turn ended, whatever the status says now. Null for hook-only sessions. */
  turnEnd: "finished" | "mid-turn" | "failing" | null;
  lastActivity: string;
}

export interface Ref {
  kind: "card" | "pr";
  id: number;
  title: string;
  url: string;
  /** card: its Shortcut workflow state, lowercased (build, test, released). pr: open | draft | merged | closed. */
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
  createdAt: string;
  expiresAt: string;
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
