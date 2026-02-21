# Notes

## App data storage

Settings and state are stored in the Electrobun app data folder (shared across instances):

- **Built app**: `Updater.appDataFolder()` → e.g. `~/.local/share/com.contextassistant.app/Context Assistant/`
- **Dev server** (`bun run dev:server`): same path via `getAppDataFolderPath()` in `src/bun/appStoragePath.ts`

Storage file: `app-storage.json`. Both the Electrobun app and dev server use this location so settings persist and stay in sync across restarts and multiple instances.

## Need to fix

- ~~settings persistance~~ (migrated to app data folder)
- initial font size and general design
  - mitigate multi-platform differences
- improve the electrobun compatible select boxes 
- Enabled local shells shell selection is showing multiple versions= of the same shell (if the shell is installed in two different places, use the first one)
- * app theme brightness range input, dim or brighten the app background colors 
- drop down menus will sometimes overflow off the bottom of the page, we need to check if the dropdown menu view will overflow off the page and if so change the height of that menu or make it pop up instead of down, or open to the right instead of to the left.
- fix unsupported filetype when opening plain text files