# watch-together

Watch local videos together, peer to peer, from a static web page.

- Link a folder of videos (File System Access API — Chrome / Edge), open them in VS Code-style tabs.
- Create a room and share the code or link; people who join ask, and the room accepts.
- Share a tab: everyone watches it — streamed from you, or from their own identical copy kept in sync.
- Everyone keeps their own volume.

No server: peers find each other through public Nostr relays ([Trystero](https://github.com/dmotz/trystero)); video, audio and commands travel directly between browsers.

## Develop

```sh
npm install
npm run dev
```

Gates: `npm run type-check`, `npm run test:unit`, `npm run build`.

## License

MIT — see [LICENSE](LICENSE).
