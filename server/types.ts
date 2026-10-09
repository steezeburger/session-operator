export type SessionStatus = "waiting" | "failing" | "working" | "done" | "blocked" | "idle";

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
  /** A Claude process for this session is running, so the deck can type a reply into it. */
  live: boolean;
  /** What the session is waiting on outside Jesse (CI, a deploy, a review), when status is "blocked". */
  blockedOn: string | null;
  status: SessionStatus;
  statusDetail: string;
  lastActivity: string;
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

export interface DeckState {
  pending: PendingDecision[];
  sessions: Session[];
}

export type Behavior = "allow" | "deny";

export interface FeedItem {
  kind: "user" | "assistant" | "tool" | "error";
  text: string;
  at: string | null;
}
