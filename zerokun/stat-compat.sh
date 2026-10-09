# Portable file metadata for the shell entrypoints (macOS BSD stat / Linux GNU stat).
#
# macOS: /usr/bin/stat -f '%u' '%l' '%Lp' '%HT'
# Linux: stat -c '%u' '%h' '%a' '%F'
# Callers compare the printed values, so each helper prints one normalized token
# and fails (prints nothing, returns 1) when the path cannot be read.
# Sourced by state-dir.sh / codex-version.sh; watchdog.sh carries an inline copy
# because the installed copy runs standalone with PATH=/usr/bin:/bin.

ZEROKUN_KERNEL="${ZEROKUN_KERNEL:-$(/usr/bin/uname -s 2>/dev/null || uname -s)}"

zerokun_stat_owner() {
  if [ "$ZEROKUN_KERNEL" = "Darwin" ]; then
    /usr/bin/stat -f '%u' "$1" 2>/dev/null
  else
    stat -c '%u' "$1" 2>/dev/null
  fi
}

zerokun_stat_links() {
  if [ "$ZEROKUN_KERNEL" = "Darwin" ]; then
    /usr/bin/stat -f '%l' "$1" 2>/dev/null
  else
    stat -c '%h' "$1" 2>/dev/null
  fi
}

# Octal permission bits without the file type (600, 700, 755 ...).
zerokun_stat_perm() {
  if [ "$ZEROKUN_KERNEL" = "Darwin" ]; then
    /usr/bin/stat -f '%Lp' "$1" 2>/dev/null
  else
    stat -c '%a' "$1" 2>/dev/null
  fi
}

# One of: symlink, regular, directory, or the kernel's lowercase description.
zerokun_stat_type() {
  local raw
  if [ "$ZEROKUN_KERNEL" = "Darwin" ]; then
    raw="$(LANG=C LC_ALL=C /usr/bin/stat -f '%HT' "$1" 2>/dev/null)" || return 1
  else
    raw="$(LANG=C LC_ALL=C stat -c '%F' "$1" 2>/dev/null)" || return 1
  fi
  case "$raw" in
    'Symbolic Link'|'symbolic link') printf 'symlink\n' ;;
    'Regular File'|'regular file'|'regular empty file') printf 'regular\n' ;;
    'Directory'|'directory') printf 'directory\n' ;;
    *) printf '%s\n' "$raw" | /usr/bin/tr '[:upper:]' '[:lower:]' ;;
  esac
}

# "<uid>:<nlink>" — the owner-only regular file check used across the scripts.
zerokun_stat_owner_links() {
  local owner links
  owner="$(zerokun_stat_owner "$1")" || return 1
  links="$(zerokun_stat_links "$1")" || return 1
  printf '%s:%s\n' "$owner" "$links"
}
