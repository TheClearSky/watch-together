import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { RoomSession, RoomSnapshot } from "./session";
import { canApprove, canShare, shareRuleOf } from "./roomModel";
import type { Member } from "./roomModel";
import { Avatar, avatarSeed } from "../social/Avatar";
import { InviteShare } from "../social/InviteShare";

/**
 * Everything about the current room: the invite, who is here, join requests
 * (for approvers), the owner's controls (Q5 sharing — a default plus per
 * person allow / deny / follow default; Q6 approvers), and leaving.
 * A column beside the content on wide screens, a full-screen sheet on phones.
 */

type RoomPanelProps = {
  session: RoomSession;
  snapshot: RoomSnapshot;
  onClose(): void;
  /** Shown under the invite while in the room (shares). */
  sharing?: ReactNode;
  /** Shown above "Leave room" while in the room (chat). */
  chat?: ReactNode;
  /** Ask before removing someone (the app's dialog). */
  confirmRemove?(name: string): Promise<boolean>;
  /** Open Settings → Connection (the user's own relay server). */
  onOpenConnection?(): void;
};

const SMALL_BUTTON =
  "cursor-pointer rounded px-2 py-1 text-[12px] hover:bg-secondary-dark-gray disabled:cursor-default disabled:opacity-40 pointer-coarse:px-3 pointer-coarse:py-2 pointer-coarse:text-[14px]";
const SECTION_TITLE =
  "mb-2 text-[11px] font-semibold tracking-[0.12em] text-primary-light-gray uppercase";

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function RoomPanel({
  session,
  snapshot,
  onClose,
  sharing,
  chat,
  confirmRemove,
  onOpenConnection,
}: RoomPanelProps) {
  const { status, room, me, online, requests, code, link } = snapshot;
  const now = useNow(1000);
  const isOwner = room?.owner === me.memberId;
  const iApprove = room ? canApprove(room, me.memberId) : false;

  const members: Member[] = room
    ? Object.values(room.members).sort(
        (a, b) =>
          Number(b.id === room.owner) - Number(a.id === room.owner) ||
          a.admittedAt - b.admittedAt,
      )
    : [];

  return (
    <aside
      aria-label="Room"
      className="flex h-full w-full flex-col overflow-y-auto border-l border-secondary-dark-gray bg-secondary-black text-[13px] md:w-[340px] md:flex-none pointer-coarse:text-[15px]"
    >
      <div className="flex items-center gap-2 border-b border-secondary-dark-gray px-3 py-2">
        <span className="mr-auto text-[12px] font-semibold tracking-wide text-primary-light-gray uppercase">
          Room
        </span>
        <button
          type="button"
          className={SMALL_BUTTON}
          aria-label="Close room panel"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      {snapshot.notice && (
        <div
          role="status"
          className="flex items-start gap-2 border-b border-accent/40 bg-accent/10 px-3 py-2"
        >
          <span className="flex-1">{snapshot.notice}</span>
          <button
            type="button"
            className={SMALL_BUTTON}
            aria-label="Dismiss"
            onClick={() => session.dismissNotice()}
          >
            ✕
          </button>
        </div>
      )}

      {status.kind === "waiting" && code && (
        <section className="flex flex-col gap-3 border-b border-secondary-dark-gray p-3">
          <p>
            ⏳ Asking to join <strong>{code}</strong>…
          </p>
          <p className="text-primary-light-gray">
            {status.heard === 0 && (status.unreachable ?? 0) > 0
              ? "Found the room, but your network and theirs can’t connect directly (common with mobile data). Join the same Wi-Fi, use one phone’s hotspot, or add a relay in Connection settings."
              : status.heard === 0
                ? Math.round((now - status.since) / 1000) < 12
                  ? "Looking for the room…"
                  : "Nobody from this room is online yet. The person who made it needs to keep the page open (on a phone: screen on, browser in front) — or the code may be mistyped."
                : "Connected — waiting for someone to let you in."}{" "}
            <span className="tabular-nums">
              {Math.round((now - status.since) / 1000)} s
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={SMALL_BUTTON}
              onClick={() => void session.leave()}
            >
              Cancel
            </button>
            {status.heard === 0 &&
              (status.unreachable ?? 0) > 0 &&
              onOpenConnection && (
                <button
                  type="button"
                  className={`${SMALL_BUTTON} text-accent`}
                  onClick={onOpenConnection}
                >
                  Connection settings
                </button>
              )}
            {status.heard === 0 &&
              !status.unreachable &&
              now - status.since > 12_000 && (
                <button
                  type="button"
                  className={`${SMALL_BUTTON} text-accent`}
                  onClick={() => void session.createInstead()}
                >
                  Create “{code}” instead
                </button>
              )}
          </div>
        </section>
      )}

      {status.kind === "rejected" && (
        <section className="border-b border-secondary-dark-gray p-3">
          <p>
            {status.reason === "banned"
              ? "You were removed from this room."
              : "Your request to join was declined."}
          </p>
          <button
            type="button"
            className={`${SMALL_BUTTON} mt-2`}
            onClick={() => void session.leave()}
          >
            OK
          </button>
        </section>
      )}
      {status.kind === "kicked" && (
        <section className="border-b border-secondary-dark-gray p-3">
          <p>You were removed from the room.</p>
          <button
            type="button"
            className={`${SMALL_BUTTON} mt-2`}
            onClick={() => void session.leave()}
          >
            OK
          </button>
        </section>
      )}

      {status.kind === "in-room" && room && code && (
        <>
          <section className="border-b border-secondary-dark-gray p-3">
            <h3 className={SECTION_TITLE}>Invite</h3>
            <p className="mb-2 text-primary-light-gray">
              Room <code className="font-mono text-primary-white">{code}</code>{" "}
              — send the link, or let them scan it.
            </p>
            <InviteShare code={code} link={link!} from={snapshot.me.name} />
          </section>

          {sharing}

          {iApprove && requests.length > 0 && (
            <section className="border-b border-secondary-dark-gray bg-status-warning/5 p-3">
              <h3 className={SECTION_TITLE}>
                Wants to join ({requests.length})
              </h3>
              <ul className="flex flex-col gap-2">
                {requests.map((request) => (
                  <li
                    key={request.memberId}
                    className="flex items-center gap-2"
                  >
                    <Avatar
                      seed={avatarSeed(request.avatar, request.memberId)}
                      size={28}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {request.name}
                    </span>
                    <button
                      type="button"
                      className={SMALL_BUTTON}
                      onClick={() => void session.reject(request.memberId)}
                    >
                      Decline
                    </button>
                    <button
                      type="button"
                      className={`${SMALL_BUTTON} bg-accent text-primary-black hover:brightness-110`}
                      onClick={() => void session.approve(request.memberId)}
                    >
                      Let in
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="border-b border-secondary-dark-gray p-3">
            <h3 className={SECTION_TITLE}>People · {online.size} here</h3>
            <ul className="flex flex-col gap-1">
              {members.map((member) => {
                const here = online.has(member.id);
                const you = member.id === me.memberId;
                const ownerRow = member.id === room.owner;
                return (
                  <li
                    key={member.id}
                    className="flex flex-col gap-1 rounded px-1 py-1"
                  >
                    <div className="flex items-center gap-2">
                      <span className="relative flex-none">
                        <Avatar
                          seed={avatarSeed(member.avatar, member.id)}
                          size={28}
                          className={here ? "" : "opacity-40 grayscale"}
                        />
                        <span
                          aria-label={here ? "online" : "offline"}
                          className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-secondary-black ${here ? "bg-status-completed" : "bg-secondary-light-gray"}`}
                        />
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {ownerRow
                          ? "👑 "
                          : room.approvers.includes(member.id)
                            ? "🛡 "
                            : ""}
                        {member.name}
                        {you && (
                          <span className="text-primary-light-gray">
                            {" "}
                            (you)
                          </span>
                        )}
                      </span>
                      {!ownerRow && (
                        <span className="text-[11px] text-primary-light-gray pointer-coarse:text-[12px]">
                          {canShare(room, member.id)
                            ? "can share"
                            : "can’t share"}
                        </span>
                      )}
                    </div>
                    {isOwner && !ownerRow && (
                      <div className="ml-4 flex flex-wrap items-center gap-2 text-[12px] pointer-coarse:text-[14px]">
                        <label className="flex items-center gap-1">
                          Share
                          <select
                            value={shareRuleOf(room, member.id)}
                            onChange={(event) =>
                              session.setShareRule(
                                member.id,
                                event.currentTarget.value as
                                  "allow" | "deny" | "inherit",
                              )
                            }
                            className="rounded bg-primary-black px-1 py-0.5 pointer-coarse:py-1.5"
                          >
                            <option value="inherit">
                              Default (
                              {room.shareDefault === "everyone"
                                ? "allowed"
                                : "not allowed"}
                              )
                            </option>
                            <option value="allow">Allow</option>
                            <option value="deny">Deny</option>
                          </select>
                        </label>
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={room.approvers.includes(member.id)}
                            onChange={(event) =>
                              session.setApprover(
                                member.id,
                                event.currentTarget.checked,
                              )
                            }
                            className="accent-accent pointer-coarse:h-5 pointer-coarse:w-5"
                          />
                          Can let people in
                        </label>
                        <button
                          type="button"
                          className={SMALL_BUTTON}
                          onClick={() => session.transferOwnership(member.id)}
                        >
                          Make owner
                        </button>
                        <button
                          type="button"
                          className={`${SMALL_BUTTON} text-status-errored`}
                          onClick={() => {
                            void (
                              confirmRemove?.(member.name) ??
                              Promise.resolve(true)
                            ).then((yes) => {
                              if (yes) void session.kick(member.id);
                            });
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {isOwner && (
            <section className="border-b border-secondary-dark-gray p-3">
              <h3 className={SECTION_TITLE}>Who can share a tab</h3>
              <div className="flex flex-col gap-1">
                {(["everyone", "nobody"] as const).map((value) => (
                  <label key={value} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="share-default"
                      checked={room.shareDefault === value}
                      onChange={() => session.setShareDefault(value)}
                      className="accent-accent pointer-coarse:h-5 pointer-coarse:w-5"
                    />
                    {value === "everyone"
                      ? "Everyone (default)"
                      : "Only people I allow"}
                  </label>
                ))}
                <p className="text-[12px] text-primary-light-gray pointer-coarse:text-[13px]">
                  Per-person Allow / Deny above overrides this. You can always
                  share.
                </p>
              </div>
            </section>
          )}

          {chat}

          <section className="mt-auto flex flex-wrap items-center gap-2 p-3">
            {onOpenConnection && (
              <button
                type="button"
                className={SMALL_BUTTON}
                onClick={onOpenConnection}
              >
                Connection settings
              </button>
            )}
            <button
              type="button"
              className={`${SMALL_BUTTON} text-status-errored`}
              onClick={() => void session.leave()}
            >
              Leave room
            </button>
          </section>
        </>
      )}
    </aside>
  );
}

export { RoomPanel };
