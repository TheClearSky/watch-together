import type { ReactNode } from 'react';
import type { Line } from '@theclearsky/easy-tutorial-builder';

/**
 * The script text format's tiny markdown subset — `**bold**`, `*em*`,
 * `` `code` ``, `[[key]]` — turned into React elements. Never HTML: a
 * script is data and may one day come from outside the app.
 */

const TOKEN = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[\[[^\]]+\]\])/g;

function inline(text: string): ReactNode[] {
  return text.split(TOKEN).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      return (
        <strong key={index} className='font-semibold text-[#ffe08a]'>
          {part.slice(2, -2)}
        </strong>
      );
    if (part.startsWith('[[') && part.endsWith(']]'))
      return (
        <kbd
          key={index}
          className='mx-0.5 inline-block min-w-[1.6em] rounded border border-b-2 border-secondary-light-gray bg-secondary-black px-1 text-center text-[12px] leading-5'
        >
          {part.slice(2, -2)}
        </kbd>
      );
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
      return (
        <code key={index} className='rounded bg-secondary-black px-1 text-[12px]'>
          {part.slice(1, -1)}
        </code>
      );
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={index}>{part.slice(1, -1)}</em>;
    return part;
  });
}

/** The same words without markup — for the screen-reader live region. */
function plainText(lines: readonly Line[]): string {
  return lines
    .map((line) => line.say.replace(/\*\*|`|\[\[|\]\]/g, '').replace(/\*([^*]+)\*/g, '$1'))
    .join(' ');
}

export { inline, plainText };
