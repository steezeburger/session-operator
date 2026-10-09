export type SessionStatus = "waiting" | "failing" | "working" | "done" | "idle";

export interface Session {
  id: string;
  cwd: string;
  project: string;
  branch: string | null;
  title: string | null;
  lastPrompt: string | null;
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
