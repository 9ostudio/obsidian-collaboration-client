# obsidian-collaboration-client

Real-time end-to-end encrypted shared folders for Obsidian with permission system for read / write / delete and a local folder sync between all user through obsidian.

- Share a folder with an invite link, and it appears in the other person's vault.
- Edit notes and canvases together in real time, even while the owner is offline.
- Choose who can read, write and delete. Remove someone and the folder leaves their vault.
- Every file keeps its version history, and deleted files can be restored.
- Attachments land in the shared folder's `data` folder.
- Link a shared folder to a folder on your computer to keep both in sync (desktop).

## Install

Install the [server](https://github.com/9ostudio/obsidian-collaboration-server) and open the owner link it prints. Then right-click a folder and choose **Share folder…**.

## Privacy

Connects only to your server. Notes, files and names are encrypted on your device, so the server can't read them. No telemetry. The Copy button puts invite links on the clipboard, and nothing is read from it. Linked folders outside the vault are read and written by the plugin, and files deleted there go to the system trash.

## License

MIT. Includes [diff-match-patch](https://github.com/google/diff-match-patch) (Apache-2.0).
