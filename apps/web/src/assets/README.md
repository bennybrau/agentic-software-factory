# Vendored Material Symbols subset

`material-symbols-subset.woff2` is a **self-hosted subset** of Google's
[Material Symbols Outlined](https://github.com/google/material-design-icons)
font (Apache 2.0), so the app renders its nav/action icons offline with no CDN
dependency. It is referenced by the `@font-face` in `../styles.css`.

## IMPORTANT: the subset must contain every icon the app uses

Icons render via CSS ligatures: `<span class="material-symbols-outlined">checklist</span>`
shapes the text `checklist` into one icon glyph. **If a used icon name is not in
the subset, the ligature never forms and the browser prints the raw word**
(e.g. a literal "checklist" in the sidebar). This bug has shipped three times:
`checklist`, `history`, and `add_task` (New task) were each missing from the subset.

`../icons.test.ts` now guards this in CI: it scans the web source for every icon
name and checks the woff2's GSUB table has a ligature for each. If it fails,
regenerate the subset below.

The icon names in use live in `../components/Sidebar.tsx` (the `LINKS` array,
`icon:` field) and any inline `material-symbols-outlined` spans (e.g.
`NotificationBell.tsx` → `notifications`, `Attachments.tsx` → attachment icons).
Current set:

    add_task  chat  checklist  dashboard  description  event_repeat
    history  notifications  picture_as_pdf  settings  tune

## Regenerating (when you add/remove an icon)

Update the comma list below to match the icons in use, then fetch the subset
from Google Fonts with a **desktop UA** (so it serves `woff2`) and the variable
weight range the CSS expects (`font-weight: 100 700`):

    ICONS="add_task,chat,dashboard,description,event_repeat,history,notifications,picture_as_pdf,settings,tune"
    UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    CSS="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&icon_names=${ICONS}&display=block"
    URL=$(curl -sL -A "$UA" "$CSS" | grep -oE 'url\([^)]+\)' | head -1 | sed -E 's/^url\(//;s/\)$//')
    curl -sL -A "$UA" "$URL" -o material-symbols-subset.woff2

Then verify EVERY icon shapes to a single glyph before committing (needs
`fonttools` + `uharfbuzz`): decompress to ttf and HarfBuzz-shape each name,
asserting it collapses to exactly one non-.notdef glyph. A subset that misses an
icon shapes that name into per-letter glyphs (the fallback that prints the word).
