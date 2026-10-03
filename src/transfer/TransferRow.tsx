import { formatBytes } from '@theclearsky/easy-folder-management-ui';
import type { Downloads, TransferView } from './downloads';

const SMALL_BUTTON =
  'cursor-pointer rounded px-2 py-1 text-[12px] hover:bg-white/10 pointer-coarse:px-3 pointer-coarse:py-2 pointer-coarse:text-[14px]';

/** One copy in flight (or finished), with its progress and controls. */
function TransferRow({ transfer, downloads, compact = false }: { transfer: TransferView; downloads: Downloads; compact?: boolean }) {
  const fraction = transfer.size > 0 ? transfer.done / transfer.size : 0;
  const label =
    transfer.direction === 'out'
      ? `Copy for ${transfer.peerName}`
      : transfer.status === 'asking'
        ? `Asking ${transfer.peerName} for a copy…`
        : 'Saving a copy';
  const live = transfer.status === 'transferring' || transfer.status === 'asking' || transfer.status === 'saving';
  return (
    <div className={`flex flex-col gap-1 rounded bg-white/5 px-2 py-1 text-[12px] pointer-coarse:text-[14px] ${compact ? '' : 'mt-1'}`}>
      <div className='flex items-center gap-2'>
        <span className='min-w-0 flex-1 truncate'>
          {transfer.direction === 'out' ? '⬆' : '⬇'} {label}
          {transfer.status === 'transferring' && (
            <span className='text-primary-light-gray tabular-nums'>
              {' '}
              · {Math.floor(fraction * 100)}% · {formatBytes(transfer.rate)}/s
            </span>
          )}
          {transfer.status === 'done' && <span className='text-status-completed'> · done</span>}
          {transfer.status === 'declined' && <span className='text-status-warning'> · declined</span>}
          {transfer.status === 'cancelled' && <span className='text-primary-light-gray'> · cancelled</span>}
          {transfer.status === 'failed' && <span className='text-status-errored'> · {transfer.error ?? 'failed'}</span>}
        </span>
        {live ? (
          <button type='button' className={SMALL_BUTTON} aria-label='Cancel copy' onClick={() => downloads.cancel(transfer.id)}>
            ✕
          </button>
        ) : (
          <button type='button' className={SMALL_BUTTON} aria-label='Dismiss' onClick={() => downloads.dismiss(transfer.id)}>
            ✕
          </button>
        )}
      </div>
      {transfer.status === 'transferring' && (
        <div className='h-1 w-full overflow-hidden rounded bg-white/10'>
          <div className='h-full bg-accent' style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

export { TransferRow };
