import type { UserPreferences } from "./theme";

export interface User {
  id: number;
  username: string;
  display_name: string;
  role: "admin" | "user";
  avatar_file_id: number | null;
  email: string | null;
  disabled: boolean;
  /** Removed by an admin; shown as "Deleted user" and can't be re-enabled. */
  deleted: boolean;
  created_at: string;
  oidc_linked: boolean;
  status_text?: string;
  must_change_password?: boolean;
  totp_enabled?: boolean;
  status: "online" | "away" | "dnd" | "offline";
  preferences?: UserPreferences;
}

export interface UserBrief {
  id: number;
  display_name: string;
  username: string;
  avatar_file_id: number | null;
}

export interface GroupMember extends UserBrief {
  role: "owner" | "admin" | "member";
}

export interface FileBrief {
  id: number;
  name: string;
  mime: string;
  size: number;
}

export interface MessagePreview {
  id: number;
  content: string;
  has_file: boolean;
  deleted: boolean;
  is_encrypted: boolean;
  sender?: UserBrief;
}

export interface MessageReaction {
  message_id: number;
  user_id: number;
  emoji: string;
}

export interface Message {
  id: number;
  sender_id: number;
  recipient_id: number | null;
  group_id: number | null;
  file_id: number | null;
  content: string;
  sent_at: string;
  delivered_at: string | null;
  read_at: string | null;
  deleted_at?: string | null;
  edited_at?: string | null;
  reply_to_id?: number | null;
  pinned_at?: string | null;
  is_encrypted: boolean;
  enc_iv?: string | null;
  enc_keys?: string | null;
  mentions?: number[];
  /** Set on a reply that lives inside another message's thread. */
  thread_root_id?: number | null;
  /** On a thread's first message: how many replies it has. */
  thread_count?: number;
  poll?: Poll;
  reply_to?: MessagePreview;
  reactions?: MessageReaction[];
  sender?: UserBrief;
  file?: FileBrief;
  /** client-only: optimistic message not yet acked by the server */
  pending?: boolean;
  /** client-only: send attempt failed, eligible for retry */
  failed?: boolean;
  /** client-only: client id used for websocket ack matching */
  clientID?: string;
}

export interface PollOption {
  id: number;
  text: string;
  /** ids of the people who voted for it */
  votes: number[];
}

export interface Poll {
  id: number;
  question: string;
  multi: boolean;
  closed: boolean;
  options: PollOption[];
}

export interface Group {
  /** Public groups are channels anyone can find and join. */
  public?: boolean;
  member_count?: number;
  id: number;
  name: string;
  topic: string;
  created_by: number;
  created_at: string;
  avatar_file_id: number | null;
  members: GroupMember[];
}

export interface CallParticipant {
  user_id: number;
  joined_at: string | null;
  left_at: string | null;
  missed: boolean;
  user: UserBrief;
}

export interface Call {
  id: number;
  room_id: string;
  initiator_id: number;
  is_conference: boolean;
  started_at: string;
  ended_at: string | null;
  initiator?: UserBrief;
  participants?: CallParticipant[];
}

export interface ParticipantInfo {
  user_id: number;
  display_name: string;
  avatar_file_id: number | null;
  muted: boolean;
  video_on: boolean;
  screen: boolean;
  host: boolean;
  locked: boolean;
  can_present: boolean;
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface AdminStats {
  version: string;
  uptime_hours: number;
  users: number;
  online: number;
  active_calls: number;
  db_driver: string;
  storage: { db_bytes: number; files_bytes: number; total_bytes: number };
}

export interface DeviceKey {
  user_id: number;
  device_id: string;
  public_key_jwk: string;
}

export interface SettingView {
  key: string;
  label: string;
  description: string;
  kind: "string" | "int" | "bool" | "secret";
  group: string;
  editable: boolean;
  value: string;
  source: "env" | "db" | "default";
}

export interface AuditEntry {
  id: number;
  actor_id: number | null;
  actor_name: string;
  action: string;
  target_type: string;
  target_id: number | null;
  detail: string;
  ip: string;
  created_at: string;
}

export type Convo =
  | { kind: "dm"; peerID: number }
  | { kind: "group"; groupID: number };

export interface PrivateRoom {
  id: string; // shareable room code
  name: string;
  owner?: UserBrief;
  require_passcode: boolean;
  require_approval: boolean;
  is_owner: boolean;
  created_at: string;
  /** Start time of a scheduled meeting (ISO), empty for an instant room. */
  scheduled_at?: string;
}

export interface BackupSnapshot {
  name: string;
  size: number;
  created_at: string;
}

export interface SessionInfo {
  id: string;
  user_agent: string;
  ip: string;
  created_at: string;
  last_seen: string;
  current: boolean;
}

export interface ConvoPref {
  kind: "dm" | "group";
  target_id: number;
  muted: boolean;
  archived: boolean;
}
