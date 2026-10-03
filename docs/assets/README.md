# Assets

`screenshot.png` shows the real React frontend at 1280×800, with deterministic
E2E media/API fixtures and the current source version. It is a demonstration of
the source UI, not a capture of personal files or proof of a packaged release.
Refresh it when the main workflow changes; never fabricate an interface image.

With Node 24 and the locked frontend dependencies installed, run from `frontend/`:

```powershell
$env:UPDATE_MEDIA_SORTER_SCREENSHOT = '1'
npx playwright test e2e/a11y.spec.ts --project chromium --grep 'media fixture reaches every screen' --workers 1
Remove-Item Env:UPDATE_MEDIA_SORTER_SCREENSHOT
```

On macOS/Linux prefix the same command with `UPDATE_MEDIA_SORTER_SCREENSHOT=1`.
Install Chromium once with `npx playwright install chromium` if needed. Review
the saved image for loading states, overflow and private data before committing.
