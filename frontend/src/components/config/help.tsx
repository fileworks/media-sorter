export const HELP = {
  sortBy: (
    <>
      <strong>How deep to organize folders.</strong>
      <br />
      <code>Year</code> → <em>2024/photo.jpg</em>
      <br />
      <code>Year › Month</code> → <em>2024/03/photo.jpg</em>
      <br />
      <code>Year › Month › Day</code> → <em>2024/03/15/photo.jpg</em>
    </>
  ),
  cameraSubfolder: (
    <>
      <strong>Add a per-camera subfolder so each device's shots stay together.</strong>
      <br />
      Reads the EXIF make and model: <em>2024/03/15/iPhone-15-Pro/photo.jpg</em>
      <br />
      Files without camera info go straight into the date folder.
    </>
  ),
  copyVsMove: (
    <>
      <strong>Copy</strong> leaves your originals untouched in the source folder.
      <br />
      <strong>Move</strong> deletes each original after it's safely copied.
      <br />
      <em>Tip: use Copy for your first run so you can verify the result.</em>
    </>
  ),
  renameFiles: (
    <>
      <strong>Give sorted files consistent, date-based names.</strong>
      <br />
      Build a pattern from the variable chips below; the live preview shows the result.
    </>
  ),
  duplicateExact: (
    <>
      <strong>Catch byte-for-byte identical files.</strong>
      <br />
      Uses a SHA-256 hash, so it finds exact copies even when they have different names. Fast and
      100% reliable.
    </>
  ),
  duplicatePerceptual: (
    <>
      <strong>Catch visually near-identical files.</strong>
      <br />
      Spots copies that were re-compressed, slightly cropped, or resized. Works on images and on
      videos (by sampling frames).
      <br />
      <em>Preview skips video sampling for speed; the real sort still catches video duplicates.</em>
    </>
  ),
  duplicateThreshold: (
    <>
      <strong>How similar two files must look to count as duplicates.</strong>
      <br />
      <code>100%</code> — pixel-perfect identical
      <br />
      <code>95%</code> — nearly identical, e.g. re-compressed JPEG (default)
      <br />
      <code>85%</code> — heavily edited or cropped copy
      <br />
      <em>Going below 85% sharply increases false positives.</em>
    </>
  ),
  dedupAgainstDestination: (
    <>
      <strong>Also compare against media already in the destination.</strong>
      <br />
      Indexes what your destination already contains (kept up to date across runs), so a source file
      that's already in your library lands in <code>_already_in_destination/</code> instead of being
      added twice. Sorting a second source after a first one also catches duplicates between the two
      runs.
      <br />
      <em>
        The index is a small hidden file inside the destination; the first run over a large library
        takes a while, re-runs are fast.
      </em>
    </>
  ),
  junkFilter: (
    <>
      <strong>Set aside thumbnails and cache debris.</strong>
      <br />
      Tiny previews, <code>Thumbs.db</code>-style files and <code>.thumbnails/</code> folders are
      quarantined to <code>_junk/</code> — never deleted, so a false positive is always recoverable.
      Recommended for messy phone or old-HDD dumps.
    </>
  ),
  junkMinSize: (
    <>
      <strong>Files smaller than this are junk.</strong>
      <br />
      Real photos are rarely under <code>8 KB</code>; thumbnails usually are. <code>0</code>{" "}
      disables the size check.
    </>
  ),
  junkMinDimension: (
    <>
      <strong>Images with a shorter side under this are junk.</strong>
      <br />A <code>200 px</code> floor catches preview-sized images without touching real photos.{" "}
      <code>0</code> disables the resolution check.
    </>
  ),
  junkPatterns: (
    <>
      <strong>Name patterns that mark a file (or its folder) as junk.</strong>
      <br />
      Shell globs, matched against the filename and every parent folder name: <code>*-thumb.*</code>
      , <code>.thumbnails</code>.
    </>
  ),
  recursiveScan: (
    <>
      <strong>Look inside subfolders of the source folder.</strong>
      <br />
      Turn this off to sort only the files sitting directly in the source root.
    </>
  ),
  minFileSize: (
    <>
      <strong>Skip files smaller than this.</strong>
      <br />
      Handy for ignoring thumbnails and system files (Thumbs.db, @eaDir previews).
      <br />
      <code>50 KB</code> filters most junk while keeping every real photo.
    </>
  ),
  maxFileSize: (
    <>
      <strong>Skip files larger than this.</strong>
      <br />
      Leave blank to process files of any size.
    </>
  ),
  excludePatterns: (
    <>
      <strong>Name patterns to skip while scanning.</strong>
      <br />
      Supports shell globs: <code>@eaDir</code>, <code>*.tmp</code>, <code>.@__thumb</code>.
      <br />
      Matches any part of the path, not just the filename. The defaults cover common NAS and
      cloud-sync folders.
    </>
  ),
  preserveSubfolders: (
    <>
      <strong>Recreate your source subfolders inside each date folder.</strong>
      <br />
      Off (default): <em>2024/03/15/IMG_001.jpg</em> — files go straight into the date folder.
      <br />
      On: <em>2024/03/15/Vacation/IMG_001.jpg</em> — keeps the original "Vacation" subfolder.
    </>
  ),
  overrideMetadata: (
    <>
      <strong>Rewrite the EXIF date in the sorted copy to match the date we extracted.</strong>
      <br />
      Use it to fix files whose camera clock was wrong.
      <br />
      <em>Only the destination copy changes — your source is never modified.</em>
    </>
  ),
  convertImages: (
    <>
      <strong>Convert every image to a single format.</strong>
      <br />
      Standardize a mixed library; RAW and HEIC are decoded and re-saved.
      <br />
      <em>In Copy mode your originals stay put — only the sorted copy is converted.</em>
    </>
  ),
  convertVideos: (
    <>
      <strong>Re-encode every video to one container and codec.</strong>
      <br />
      Improves playback compatibility.{" "}
      <em>Transcoding is CPU-heavy and slow on large libraries.</em>
    </>
  ),
  repair: (
    <>
      <strong>Check each sorted file and try to repair simple corruption.</strong>
      <br />
      Images are re-encoded and videos remuxed only if they fail validation. Repairs are verified
      before replacing the file; anything unrepairable goes to <code>_corrupted/</code>.
      <br />
      <em>Turn off for maximum speed if you trust your files are intact.</em>
    </>
  ),
  aiTagging: (
    <>
      <strong>Analyze photos & videos and tag them by content.</strong>
      <br />
      Detected tags are saved into each file (EXIF keywords for photos, metadata for videos, a{" "}
      <code>.xmp</code> sidecar otherwise) and into the report.
      <br />
      <em>Runs during sorting only — not in preview.</em>
    </>
  ),
  aiProvider: (
    <>
      <strong>Local</strong> runs fully offline on your machine — no key, no internet, free forever
      (first run downloads a one-time model). The cloud options are higher quality and need a free
      API key.
    </>
  ),
  aiEmbed: (
    <>
      Write the tags <strong>into the files</strong> (photo EXIF keywords / video metadata / a{" "}
      <code>.xmp</code> sidecar for formats that can't embed). Turn off to keep tags in the report
      only.
    </>
  ),
  aiLabels: (
    <>
      The vocabulary the <strong>local</strong> model scores each image against. Add anything you
      search for in your library — e.g. <em>birthday</em>, <em>hiking</em>, <em>passport</em>. Press
      Enter or comma to add. Ignored by the cloud providers, which use their own built-in taxonomy.
    </>
  ),
  aiConfidence: (
    <>
      How much more a label must fit the image than a generic "a photo" background (0–1; 0.5 is the
      natural midpoint). Higher = fewer, more certain tags.
    </>
  ),
  categorize: (
    <>
      <strong>Sort files into your own topic folders by what they look like.</strong>
      <br />
      Each photo/video is routed into one category folder under its date:{" "}
      <em>2024/03/15/baking/cake.jpg</em>. Runs fully offline (the same local model as AI tagging).
      <br />
      <em>
        Independent of AI tagging — this decides <strong>where</strong> files go, not what tags they
        get.
      </em>
    </>
  ),
  categorizeCategories: (
    <>
      Your topic folders — add as many as you like. Press Enter or comma to add. Works best for
      things with a <strong>distinct look</strong> — <em>screenshots</em>, <em>receipts</em>,{" "}
      <em>food</em>, <em>pets</em> — and poorly for abstract ones like <em>personal</em> or{" "}
      <em>work</em>.
      <br />
      <em>
        Tip: a handful of clearly-different topics sorts most accurately. Many overlapping ones make
        the model less sure and send more files to <code>_uncategorized/</code>.
      </em>
    </>
  ),
  categorizeConfidence: (
    <>
      <strong>How sure the model must be to file something.</strong>
      <br />
      Anything below this lands in <code>_uncategorized/</code> instead of being guessed. Keep it
      high to avoid mis-filing.
    </>
  ),
  categorizeMargin: (
    <>
      The minimum gap between the best and second-best category. A larger gap means the winner must
      stand out clearly; otherwise the file goes to <code>_uncategorized/</code>.
    </>
  ),
  aiModelTier: (
    <>
      <strong>Which local model runs on your machine.</strong>
      <br />
      <code>Auto</code> picks the best one your hardware can handle.
      <br />
      <code>Lite</code> — CLIP ViT-B/32: small and fast, runs anywhere.
      <br />
      <code>Standard / Max</code> — SigLIP 2: noticeably more accurate, needs more CPU/RAM (and uses
      a GPU when available). Downloads once on first use.
      <br />
      <em>Only affects the local model — cloud tagging providers are unaffected.</em>
    </>
  ),
  aiAllowGpu: (
    <>
      Let the local model use a hardware accelerator (Apple <code>CoreML</code>, NVIDIA{" "}
      <code>CUDA</code>, or Windows <code>DirectML</code>) when one is available — much faster than
      CPU. Turn off to force CPU-only.
    </>
  ),
};
