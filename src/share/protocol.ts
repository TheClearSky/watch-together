/**
 * Messages for watching together, over the room's connections (only admitted
 * peers can send at all; the sender's member id comes from its handshake).
 * Validated with zod on arrival.
 */
import { z } from 'zod';

const shareId = z.string().regex(/^[a-z0-9]{6,16}$/);

const fingerprintSchema = z.object({ name: z.string().max(300), size: z.number().nonnegative(), sampleHash: z.string().regex(/^[0-9a-f]{64}$/) });

const playbackSchema = z.object({
  playing: z.boolean(),
  t: z.number().nonnegative(),
  rate: z.number().positive().max(4),
  at: z.number(),
});

const controlCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('play') }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('seek'), t: z.number().nonnegative() }),
  z.object({ type: z.literal('rate'), rate: z.number().positive().max(4) }),
]);

const shareMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('announce'),
    shareId,
    title: z.string().max(300),
    fingerprint: fingerprintSchema.nullable(),
    duration: z.number().nullable(),
    /** The sharer can stream (captureStream exists). */
    streamable: z.boolean(),
    controller: z.string().nullable(),
  }),
  z.object({ t: z.literal('state'), shareId, seq: z.number().int(), state: playbackSchema }),
  z.object({ t: z.literal('end'), shareId }),
  z.object({ t: z.literal('subscribe'), shareId }),
  z.object({ t: z.literal('unsubscribe'), shareId }),
  z.object({ t: z.literal('control-request'), shareId }),
  z.object({ t: z.literal('control'), shareId, controller: z.string().nullable() }),
  z.object({ t: z.literal('control-cmd'), shareId, cmd: controlCommandSchema }),
]);

const clockMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ping'), t0: z.number() }),
  z.object({ t: z.literal('pong'), t0: z.number(), t1: z.number() }),
]);

const chatMessageSchema = z.object({ id: z.string().max(40), text: z.string().trim().min(1).max(2000), at: z.number() });

type ShareMessage = z.infer<typeof shareMessageSchema>;
type ControlCommand = z.infer<typeof controlCommandSchema>;
type Playback = z.infer<typeof playbackSchema>;

export { chatMessageSchema, clockMessageSchema, shareMessageSchema };
export type { ControlCommand, Playback, ShareMessage };
