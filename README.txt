WorkLog 1.1 – desktop tracker (Windows + macOS, Electron)

Before building: put your dashboard address in src/config.json  ("defaultServer").

Build without installing anything (recommended):
  push this folder to a private GitHub repository -> Actions -> "Build tracker" -> Run workflow.
  Download WorkLog-Setup-1.1.0.exe and WorkLog-1.1.0.dmg from the run's Artifacts.

Build on your own computer (Node.js 20 LTS):
  npm install
  npm run dist:win      (on Windows)   -> dist/WorkLog-Setup-1.1.0.exe
  npm run dist:mac      (on a Mac)     -> dist/WorkLog-1.1.0.dmg
