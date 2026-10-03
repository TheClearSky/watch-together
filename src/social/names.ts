/** Friendly default names ("Merry Panda") — editable, remembered once changed. */

const ADJECTIVES = [
  'Merry', 'Cosy', 'Sunny', 'Plucky', 'Jolly', 'Snug', 'Breezy', 'Dapper', 'Peppy', 'Mellow', 'Zippy', 'Witty',
  'Lucky', 'Starry', 'Bouncy', 'Cheery', 'Swift', 'Gentle', 'Golden', 'Velvet', 'Fizzy', 'Toasty', 'Sparkly', 'Chill',
];
const NOUNS = [
  'Panda', 'Otter', 'Fox', 'Owl', 'Koala', 'Penguin', 'Puffin', 'Badger', 'Llama', 'Gecko', 'Hedgehog', 'Narwhal',
  'Popcorn', 'Nacho', 'Pretzel', 'Waffle', 'Muffin', 'Mango', 'Comet', 'Pixel', 'Lantern', 'Kite', 'Cactus', 'Walrus',
];

function friendlyName(): string {
  const pick = (list: readonly string[]) => list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}

export { friendlyName };
