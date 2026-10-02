# HTML / CSS / JavaScript starter, version 1

Click **Run** to serve this folder. No packages or build step are required.

- `index.html` contains the page.
- `style.css` contains its styles.
- `script.js` runs in your browser as a JavaScript module.

The private preview refreshes automatically after saved file changes. The same behavior
works when you open the preview in a new tab. You can also use **Refresh preview** manually.

Add another HTML file to make another page, or put `index.html` inside a folder to serve
that folder's URL. Assets use ordinary relative or root-relative URLs. Missing paths
return 404; there is no single-page app fallback or directory listing.

The bundled server listens on `0.0.0.0:3000`. Under **Run & setup**, change the working
directory to serve a different folder. If you change the preview port, change the
run command's `--port` argument to match. Dotfiles and symlinks outside the served folder
are not served. `/__repellet_static__/` is reserved for preview refresh.

Use **Stop app** to stop serving, or **Stop workspace** to stop the container.
