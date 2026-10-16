# Verification application swap

The host broker can install a job's `bellMe.app` ZIP artifact, sign it with the
local verification identity when available, register it with LaunchServices,
and launch it. Finish verification with `app_swap_restore`. `app_swap_status`
reports whether a verification transaction remains, including installations
where no original application existed.

All project states for the same macOS user share `~/.zerokun/app-swap`. A process
lock prevents concurrent operations. The original and verification directory
identities are journaled before moving either bundle. Restoration refuses to
remove a different application installed by the user, and interrupted moves can
be resumed with `app_swap_restore`. Original backups are retained when recovery
cannot complete.

The application directory and the user's backup directory must be on the same
filesystem for identity-preserving rename. A separate-volume home is currently
unsupported; a failed move keeps or restores the original instead of copying
across volumes. This restriction does not affect the usual macOS Data volume
layout.

Before updating a Mac that ran an earlier, unreleased version of PR #130, restore
any verification build using that version's broker. Its backups are under each
project state's `app-swap` directory; the new shared journal does not adopt those
backups or infer that an arbitrary installed application is safe to delete.
Do not delete an old backup to make a new installation proceed.

ZIP validation permits ordinary framework links and macOS AppleDouble metadata,
but rejects path traversal, links escaping the bundle, and entries written
through links. Name comparisons account for case and Unicode normalization, and
link targets are resolved through other links before interpreting parent paths.
Validation and installation use a private payload snapshot whose
SHA-256 must match the job's declared digest.
