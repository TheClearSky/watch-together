/** Embedded subtitles: extraction (worker), ASS rendering (JASSUB), and the
 *  wire format for stream viewers. */
export { AssLayer } from './AssLayer';
export type { AssLayerFont, AssLayerProps, AssLayerStatus } from './AssLayer';
export { buildAssScript, eventsToCues, parseAssDialogues, stripAssTags } from './assScript';
export { extractEmbeddedSubtitles, looksLikeMatroska } from './embedded';
export type { ExtractHandlers } from './embedded';
export { isFontAttachment, trackLabel } from './protocol';
export type { EmbeddedFont, ExtractionStatus, ExtractionSummary } from './protocol';
export * from './serialize';
export { useEmbeddedSubtitles } from './useEmbeddedSubtitles';
export type { EmbeddedSubtitles, EmbeddedTrack, EmbeddedTrackContent } from './useEmbeddedSubtitles';
