# Cosy FTP GLib security backport

Base: unmodified crates.io glib 0.18.5, with its original licences retained.

The only source change is the two-line upstream fix from
https://github.com/gtk-rs/gtk-rs-core/pull/1343
(merge commit 05dff0ee696f9bcd8617cd48c4b812d046d440cb), for
RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g.

In VariantStrIter::impl_get, the C output argument is a mutable pointer variable
passed by mutable reference. The original immutable reference permitted undefined
behaviour under optimization. Tauri's GTK3 dependency requires the 0.18 series,
so upgrading only glib to 0.20 is not compatible with that dependency graph.

The release-mode regression in tests/glib_variant.rs exercises forward and
reverse string-array iteration. All modified source is included in the project
and platform source archives. Remove this patch when the desktop stack adopts
an upstream version containing the fix.
