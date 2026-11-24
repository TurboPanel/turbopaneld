#!/bin/sh
# installer-screen.sh - one reusable screen layer for the installer.
#
# MOCKUP: nothing in run.sh sources this file yet. scripts/installer-screen-demo.sh
# drives it with a simulated install.
#
# POSIX sh only (tested with dash and busybox ash). Raw ANSI, no tput.
#
# Source it the way the other libs are sourced:
#   . "$SCRIPT_DIR/lib/installer-screen.sh"
#
# API
#   screen_init <version> <channel> <mode> <log-file> <area-name>...
#       mode is "daemon" or "panel". The area names are the whole plan, in
#       order (they feed the "next" line). Draws the logo header, hides the
#       cursor and installs the INT, TERM, HUP and EXIT handlers that restore it.
#   screen_area_start <name>     make <name> the "now" line, with a spinner
#   screen_sub <text> [<value>]  a detail line under "now". Three slots that
#                                fill top-down and scroll only when a fourth
#                                arrives; with a value the lines align as
#                                key and value, and a key that is already shown
#                                is updated in place.
#   screen_run <cmd> [args...]   run a real command: output goes to the log
#                                file, the spinner keeps turning meanwhile
#   screen_area_done [detail]    move <name> to the "done" line (detail: log only)
#   screen_area_fail <reason> [<next step>]
#                                "now" turns red with a cross and keeps its
#                                detail lines; then the reason, the log path
#                                and one next step
#   screen_summary <title>       the finish: the logo block with <title> and the
#                                total time replaces the body
#   screen_summary_item <value> <note>   URLs or names, aligned, note dim
#   screen_summary_warn <text>   things to act on (after the items)
#   screen_finish                log path, cursor restored
#   screen_restore               restore the terminal only (for a caller's own
#                                EXIT trap; screen_init already installs one)
#
# Layout while running (a fixed six rows, repainted in place):
#   done  preflight . release . download    14s
#   now   runtimes                           spinner
#           postgres 18   ready
#           redis 8       pulling image
#   next  database . services . health
# When "done" would overflow, the newest names stay and a count stands in for
# the older ones: +3 . health . services.
#
# Environment
#   NO_COLOR (non-empty), TERM=dumb or unset, stdout not a TTY
#                          plain one-line-per-event output, no escape codes
#   COLORTERM=truecolor|24bit   24-bit color, else the nearest 256-color index
#   SCREEN_COLS            terminal width override (also truncates plain output)
#   SCREEN_FORCE_TTY=1     draw as if stdout were a TTY (frame capture, tests)
#   SCREEN_UNICODE=0|1     force ASCII or Unicode glyphs (default: from locale)
#   SCREEN_FIXED_CLOCK=1   show 0s everywhere (reproducible captures, tests)
#
# Text passed in is shown on one line: control characters are dropped and long
# text is cut to the terminal width with an ellipsis, never wrapped. Pass ASCII
# text; cut counts bytes under dash.
#
# Brand colors (ui/design-system/turbopanel/MASTER.md, ui/global.css):
#   blue #3366cc, green #3dd68c; link blue #86a8ff, warn #f2b84b, bad #ff7a7a.

_ss_ESC=$(printf '\033')
_ss_CR=$(printf '\r')
_ss_NL=$(printf '\n_')
_ss_NL=${_ss_NL%_}

_ss_ready=0
_ss_live=0
_ss_cleaned=1
_ss_child=
_ss_active=0
_ss_drawn=0
_ss_failed=0
_ss_sum_open=0
_ss_warns=0
_ss_n=0
_ss_total=0
_ss_frame=0
_ss_cols=0
_ss_name=
_ss_ns=0
_ss_kw=0
_ss_k1=
_ss_v1=
_ss_k2=
_ss_v2=
_ss_k3=
_ss_v3=
_ss_plan=
_ss_done_list=
_ss_hdr_rows=0
_ss_in=0
_ss_items_out=0
_ss_tx=
_ss_tw=0
_ss_log=/dev/null
_ss_t0=0

_ss_now() {
  if [ "${SCREEN_FIXED_CLOCK:-}" = 1 ]; then
    printf '0'
  else
    date +%s
  fi
}

# Strip control characters (including ESC) so text cannot move the cursor.
_ss_clean() {
  printf '%s' "$1" | tr -d '\000-\037\177'
}

# _ss_fit <text> <width>: text cut to <width> columns, ellipsis when cut.
_ss_fit() {
  _f_t=$1
  _f_w=$2
  if [ "$_f_w" -le 0 ]; then
    return 0
  fi
  if [ "${#_f_t}" -le "$_f_w" ]; then
    printf '%s' "$_f_t"
  elif [ "$_f_w" -le "${#_ss_ell}" ]; then
    printf '%s' "$_ss_ell" | cut -c1-"$_f_w"
  else
    printf '%s%s' "$(printf '%s' "$_f_t" | cut -c1-$((_f_w - ${#_ss_ell})))" "$_ss_ell"
  fi
}

# _ss_pad <n>: n spaces (nothing when n <= 0).
_ss_pad() {
  if [ "$1" -gt 0 ]; then
    printf "%$1s" ''
  fi
}

# _ss_dur <seconds>: 12s, 1m 05s
_ss_dur() {
  if [ "$1" -lt 60 ]; then
    printf '%ss' "$1"
  else
    printf '%sm %02ds' $(($1 / 60)) $(($1 % 60))
  fi
}

# _ss_rgb <r> <g> <b> <fg|bg>: the color escape for the detected depth.
_ss_rgb() {
  if [ "$_ss_truecolor" = 1 ]; then
    printf '%s[%s;2;%s;%s;%sm' "$_ss_ESC" "$([ "$4" = bg ] && echo 48 || echo 38)" "$1" "$2" "$3"
  else
    printf '%s[%s;5;%sm' "$_ss_ESC" "$([ "$4" = bg ] && echo 48 || echo 38)" \
      $((16 + 36 * (($1 * 5 + 127) / 255) + 6 * (($2 * 5 + 127) / 255) + (($3 * 5 + 127) / 255)))
  fi
}

_ss_width() {
  _w_c=0
  if [ -n "${SCREEN_COLS:-}" ]; then
    _w_c=$SCREEN_COLS
  elif [ "$_ss_live" = 1 ]; then
    _w_s=$(stty size <&1 2>/dev/null) || _w_s=
    _w_c=${_w_s#* }
    [ -n "$_w_c" ] || _w_c=${COLUMNS:-80}
  fi
  case $_w_c in '' | *[!0-9]*) _w_c=0 ;; esac
  if [ "$_ss_live" = 1 ]; then
    [ "$_w_c" -ge 40 ] || _w_c=80
  fi
  _ss_cols=$_w_c
}

_ss_logf() {
  printf '%s\n' "$1" >>"$_ss_log" 2>/dev/null || :
}

# Plain mode: one event per line, cut to SCREEN_COLS when that is set.
_ss_say() {
  if [ "$_ss_cols" -gt 0 ]; then
    printf '%s\n' "$(_ss_fit "$1" $((_ss_cols - 1)))"
  else
    printf '%s\n' "$1"
  fi
}

_ss_setup_style() {
  if [ "$_ss_live" = 1 ]; then
    case ${COLORTERM:-} in
      truecolor | 24bit) _ss_truecolor=1 ;;
      *) _ss_truecolor=0 ;;
    esac
    _ss_RST="${_ss_ESC}[0m"
    _ss_BOLD="${_ss_ESC}[1m"
    _ss_DIM="${_ss_ESC}[2m"
    _ss_BLUE=$(_ss_rgb 51 102 204 fg)
    _ss_GREEN=$(_ss_rgb 61 214 140 fg)
    _ss_LINK=$(_ss_rgb 134 168 255 fg)
    _ss_WARN=$(_ss_rgb 242 184 75 fg)
    _ss_BAD=$(_ss_rgb 255 122 122 fg)
    _ss_utf=0
    case ${SCREEN_UNICODE:-} in
      1) _ss_utf=1 ;;
      0) _ss_utf=0 ;;
      *)
        case ${LC_ALL:-${LC_CTYPE:-${LANG:-}}} in
          *[Uu][Tt][Ff]-8* | *[Uu][Tt][Ff]8*) _ss_utf=1 ;;
        esac
        ;;
    esac
  else
    _ss_truecolor=0
    _ss_RST=
    _ss_BOLD=
    _ss_DIM=
    _ss_BLUE=
    _ss_GREEN=
    _ss_LINK=
    _ss_WARN=
    _ss_BAD=
    _ss_utf=0
  fi
  if [ "$_ss_utf" = 1 ]; then
    _ss_ell='…'
    _ss_ellw=1
    _ss_no='✗'
    _ss_sep=' · '
    _ss_spin_1='⠋'
    _ss_spin_2='⠙'
    _ss_spin_3='⠹'
    _ss_spin_4='⠸'
    _ss_spin_5='⠼'
    _ss_spin_6='⠴'
    _ss_spin_7='⠦'
    _ss_spin_8='⠧'
    _ss_spin_9='⠇'
    _ss_spin_10='⠏'
    _ss_spin_n=10
  else
    _ss_ell='...'
    _ss_ellw=3
    _ss_no='x'
    _ss_sep=' / '
    _ss_spin_1='|'
    _ss_spin_2='/'
    _ss_spin_3='-'
    _ss_spin_4='\'
    _ss_spin_n=4
  fi
}

# The logo as a 18x10 pixel grid (g green, b blue), drawn two pixels per cell
# with half blocks. Shapes follow ui/assets/brand/turbopanel-logo-square.svg.
_ss_logo_row() {
  case $1 in
    0) _l_t='..gg.ggbbbbbbbbbbb' _l_b='.gg.ggbbbbbbbbbbb.' ;;
    1) _l_t='gg.ggbbbbbbbbbbb..' _l_b='........bbbb......' ;;
    2) _l_t='.......bbbb.......' _l_b='......bbbb........' ;;
    3) _l_t='......bbbb........' _l_b='.....bbbb.........' ;;
    4) _l_t='....bbbb..........' _l_b='....bbbb..........' ;;
  esac
  _l_out=
  while [ -n "$_l_t" ]; do
    _l_a=${_l_t%"${_l_t#?}"}
    _l_c=${_l_b%"${_l_b#?}"}
    _l_t=${_l_t#?}
    _l_b=${_l_b#?}
    if [ "$_l_a" = "$_l_c" ]; then
      case $_l_a in
        .) _l_out="$_l_out " ;;
        g) _l_out="$_l_out${_ss_GREEN}█" ;;
        b) _l_out="$_l_out${_ss_BLUE}█" ;;
      esac
    elif [ "$_l_c" = . ]; then
      case $_l_a in
        g) _l_out="$_l_out${_ss_GREEN}▀" ;;
        b) _l_out="$_l_out${_ss_BLUE}▀" ;;
      esac
    elif [ "$_l_a" = . ]; then
      case $_l_c in
        g) _l_out="$_l_out${_ss_GREEN}▄" ;;
        b) _l_out="$_l_out${_ss_BLUE}▄" ;;
      esac
    else
      case $_l_a in
        g) _l_out="$_l_out${_ss_GREEN}$(_ss_rgb 51 102 204 bg)▀" ;;
        b) _l_out="$_l_out${_ss_BLUE}$(_ss_rgb 61 214 140 bg)▀" ;;
      esac
    fi
  done
  printf '%s%s' "$_l_out" "$_ss_RST"
}

_ss_mode_label() {
  case $_ss_mode in
    daemon) printf 'daemon' ;;
    *) printf 'control plane' ;;
  esac
}

# _ss_header_draw <colored-text>: the logo block with one line of text beside
# it. Sets _ss_hdr_rows to the number of rows it took.
_ss_header_draw() {
  if [ "$_ss_utf" = 1 ]; then
    printf '%s' "$_ss_NL"
    printf ' %s%s' "$(_ss_logo_row 0)" "$_ss_NL"
    printf ' %s%s' "$(_ss_logo_row 1)" "$_ss_NL"
    printf ' %s   %s%s' "$(_ss_logo_row 2)" "$1" "$_ss_NL"
    printf ' %s%s' "$(_ss_logo_row 3)" "$_ss_NL"
    printf ' %s%s' "$(_ss_logo_row 4)" "$_ss_NL"
    printf '%s' "$_ss_NL"
    _ss_hdr_rows=7
  else
    printf '%s %s%s%s' "$_ss_NL" "$1" "$_ss_NL" "$_ss_NL"
    _ss_hdr_rows=3
  fi
}

# Room for the header text, in columns.
_ss_header_room() {
  if [ "$_ss_utf" = 1 ]; then
    printf '%s' $((_ss_cols - 1 - 22))
  else
    printf '%s' $((_ss_cols - 2))
  fi
}

_ss_header() {
  _h_ver=$(_ss_clean "$1")
  if [ "$_ss_live" != 1 ]; then
    _h_ch=$(_ss_clean "$2")
    _ss_say "TurboPanel installer $_h_ver (channel $_h_ch, mode $(_ss_mode_label))"
    _ss_say "log: $_ss_log"
    return 0
  fi
  _h_lab=$(_ss_mode_label)
  _h_head=$(_ss_fit "TurboPanel $_h_ver" $(($(_ss_header_room) - 3 - ${#_h_lab})))
  _ss_header_draw "${_ss_BOLD}${_h_head}${_ss_RST}${_ss_DIM}${_ss_sep}${_h_lab}${_ss_RST}"
}

# _ss_done_text <room>: the finished area names joined with the separator. When
# they do not fit, the oldest are replaced by a count: +3 . health . services.
# Sets _ss_tx (text) and _ss_tw (its width in columns).
_ss_done_text() {
  _dt_room=$1
  _ss_tx=
  _ss_tw=0
  [ -n "$_ss_done_list" ] || return 0
  _dt_oifs=$IFS
  case $- in
    *f*) _dt_f=1 ;;
    *)
      _dt_f=0
      set -f
      ;;
  esac
  IFS='|'
  # shellcheck disable=SC2086
  set -- $_ss_done_list
  IFS=$_dt_oifs
  [ "$_dt_f" = 1 ] || set +f
  _dt_n=$#
  _dt_k=0
  while :; do
    _dt_txt=
    _dt_w=0
    if [ "$_dt_k" -gt 0 ]; then
      _dt_txt="+$_dt_k"
      _dt_w=$((1 + ${#_dt_k}))
    fi
    _dt_i=0
    for _dt_a in "$@"; do
      _dt_i=$((_dt_i + 1))
      [ "$_dt_i" -gt "$_dt_k" ] || continue
      if [ -n "$_dt_txt" ]; then
        _dt_txt="$_dt_txt$_ss_sep"
        _dt_w=$((_dt_w + 3))
      fi
      _dt_txt="$_dt_txt$_dt_a"
      _dt_w=$((_dt_w + ${#_dt_a}))
    done
    if [ "$_dt_w" -le "$_dt_room" ] || [ "$_dt_k" -ge $((_dt_n - 1)) ]; then
      break
    fi
    _dt_k=$((_dt_k + 1))
  done
  if [ "$_dt_w" -gt "$_dt_room" ]; then
    _dt_txt=$(_ss_fit "$_dt_a" "$_dt_room")
    _dt_w=$_dt_room
    [ "$_dt_w" -ge 0 ] || _dt_w=0
  fi
  _ss_tx=$_dt_txt
  _ss_tw=$_dt_w
}

# _ss_next_text <room>: the areas after the active one, cut with an ellipsis.
_ss_next_text() {
  _nx_room=$1
  _ss_tx=
  [ -n "$_ss_plan" ] || return 0
  _nx_oifs=$IFS
  case $- in
    *f*) _nx_f=1 ;;
    *)
      _nx_f=0
      set -f
      ;;
  esac
  IFS='|'
  # shellcheck disable=SC2086
  set -- $_ss_plan
  IFS=$_nx_oifs
  [ "$_nx_f" = 1 ] || set +f
  _nx_lim=$_nx_room
  _nx_cut=0
  while :; do
    _nx_i=0
    _nx_txt=
    _nx_w=0
    _nx_over=0
    for _nx_a in "$@"; do
      _nx_i=$((_nx_i + 1))
      [ "$_nx_i" -gt "$_ss_n" ] || continue
      _nx_add=${#_nx_a}
      [ -z "$_nx_txt" ] || _nx_add=$((_nx_add + 3))
      if [ $((_nx_w + _nx_add)) -gt "$_nx_lim" ]; then
        _nx_over=1
        break
      fi
      if [ -n "$_nx_txt" ]; then
        _nx_txt="$_nx_txt$_ss_sep"
      fi
      _nx_txt="$_nx_txt$_nx_a"
      _nx_w=$((_nx_w + _nx_add))
    done
    if [ "$_nx_over" = 0 ] || [ "$_nx_cut" = 1 ]; then
      break
    fi
    _nx_cut=1
    _nx_lim=$((_nx_room - _ss_ellw))
  done
  if [ "$_nx_over" = 1 ]; then
    if [ -z "$_nx_txt" ]; then
      _nx_txt=$(_ss_fit "$_nx_a" "$_nx_room")
    else
      _nx_txt="$_nx_txt$_ss_ell"
    fi
  fi
  _ss_tx=$_nx_txt
}

# The body is six rows, always: done, now, three detail slots, next.
_ss_row_done() {
  [ -n "$_ss_done_list" ] || return 0
  _rd_el=$(_ss_dur $(($(_ss_now) - _ss_t0)))
  _ss_done_text $((_ss_cols - 1 - 8 - 2 - ${#_rd_el}))
  printf '  %sdone%s  %s%s%s%s%s%s%s' "$_ss_GREEN" "$_ss_RST" \
    "$_ss_DIM" "$_ss_tx" "$_ss_RST" "$(_ss_pad $((_ss_cols - 1 - 8 - _ss_tw - ${#_rd_el})))" \
    "$_ss_DIM" "$_rd_el" "$_ss_RST"
}

_ss_row_now() {
  if [ "$_ss_failed" = 1 ]; then
    _rn_c=$_ss_BAD
    _rn_m=$_ss_no
  else
    _rn_c=$_ss_BLUE
    _rn_m=$(eval "printf '%s' \"\$_ss_spin_$((_ss_frame % _ss_spin_n + 1))\"")
  fi
  _rn_nm=$(_ss_fit "$_ss_name" $((_ss_cols - 1 - 8 - 2)))
  printf '  %snow%s   %s%s%s%s%s%s%s%s' "$_ss_DIM" "$_ss_RST" \
    "$_ss_BOLD" "$_rn_c" "$_rn_nm" "$_ss_RST" "$(_ss_pad $((_ss_cols - 1 - 8 - 1 - ${#_rn_nm})))" \
    "$_rn_c" "$_rn_m" "$_ss_RST"
}

# _ss_row_slot <1-3>: one detail line, key and value aligned when it has both.
_ss_row_slot() {
  [ "$1" -le "$_ss_ns" ] || return 0
  eval "_sl_k=\$_ss_k$1 _sl_v=\$_ss_v$1"
  _sl_room=$((_ss_cols - 1 - 10))
  if [ -z "$_sl_v" ]; then
    printf '          %s' "$(_ss_fit "$_sl_k" "$_sl_room")"
    return 0
  fi
  _sl_kf=$(_ss_fit "$_sl_k" "$_ss_kw")
  printf '          %s%s   %s%s%s' "$_sl_kf" "$(_ss_pad $((_ss_kw - ${#_sl_kf})))" \
    "$_ss_DIM" "$(_ss_fit "$_sl_v" $((_sl_room - _ss_kw - 3)))" "$_ss_RST"
}

_ss_row_next() {
  _ss_next_text $((_ss_cols - 1 - 8))
  [ -n "$_ss_tx" ] || return 0
  printf '  %snext  %s%s' "$_ss_DIM" "$_ss_tx" "$_ss_RST"
}

# Repaint the body in place: move up over what was drawn, rewrite all six rows.
_ss_paint() {
  [ "$_ss_live" = 1 ] || return 0
  _p_o=
  if [ "$_ss_drawn" -gt 0 ]; then
    _p_o="${_ss_ESC}[${_ss_drawn}A"
  fi
  _ss_kw=0
  _p_i=1
  while [ "$_p_i" -le "$_ss_ns" ]; do
    eval "_p_k=\$_ss_k$_p_i _p_v=\$_ss_v$_p_i"
    if [ -n "$_p_v" ] && [ "${#_p_k}" -gt "$_ss_kw" ]; then
      _ss_kw=${#_p_k}
    fi
    _p_i=$((_p_i + 1))
  done
  [ "$_ss_kw" -le 20 ] || _ss_kw=20
  _p_c="${_ss_CR}${_ss_ESC}[2K"
  _p_o="${_p_o}${_p_c}$(_ss_row_done)${_ss_NL}"
  _p_o="${_p_o}${_p_c}$(_ss_row_now)${_ss_NL}"
  _p_o="${_p_o}${_p_c}$(_ss_row_slot 1)${_ss_NL}"
  _p_o="${_p_o}${_p_c}$(_ss_row_slot 2)${_ss_NL}"
  _p_o="${_p_o}${_p_c}$(_ss_row_slot 3)${_ss_NL}"
  _p_o="${_p_o}${_p_c}$(_ss_row_next)${_ss_NL}"
  printf '%s' "$_p_o"
  _ss_drawn=6
  _ss_frame=$((_ss_frame + 1))
}

# _ss_put_sub <key> <value>: a detail line goes in the first free slot and
# fills downward; once all three are used the oldest scrolls off the top. A
# key that is already shown keeps its slot and takes the new value.
_ss_put_sub() {
  if [ -n "$2" ]; then
    _ps_i=1
    while [ "$_ps_i" -le "$_ss_ns" ]; do
      eval "_ps_k=\$_ss_k$_ps_i"
      if [ "$_ps_k" = "$1" ]; then
        eval "_ss_v$_ps_i=\$2"
        return 0
      fi
      _ps_i=$((_ps_i + 1))
    done
  fi
  if [ "$_ss_ns" -lt 3 ]; then
    _ss_ns=$((_ss_ns + 1))
  else
    _ss_k1=$_ss_k2
    _ss_v1=$_ss_v2
    _ss_k2=$_ss_k3
    _ss_v2=$_ss_v3
  fi
  eval "_ss_k$_ss_ns=\$1 _ss_v$_ss_ns=\$2"
}

_ss_clear_subs() {
  _ss_ns=0
  _ss_k1=
  _ss_v1=
  _ss_k2=
  _ss_v2=
  _ss_k3=
  _ss_v3=
}

_ss_kill_child() {
  if [ -n "$_ss_child" ]; then
    kill "$_ss_child" 2>/dev/null || :
    wait "$_ss_child" 2>/dev/null || :
    _ss_child=
  fi
}

_ss_sig() {
  _ss_kill_child
  exit "$1"
}

screen_restore() {
  if [ "$_ss_live" = 1 ]; then
    printf '%s[0m%s[?25h' "$_ss_ESC" "$_ss_ESC"
  fi
}

# Runs once on exit, error, INT and TERM: close the active area, restore the cursor.
_ss_cleanup() {
  _cl_rc=$?
  [ "$_ss_cleaned" = 0 ] || return 0
  _ss_cleaned=1
  trap - EXIT INT TERM HUP
  _ss_kill_child
  if [ "$_ss_active" = 1 ]; then
    screen_area_fail "stopped unexpectedly (exit $_cl_rc)"
  fi
  if [ "$_ss_ready" = 1 ] && [ "$_ss_failed" = 1 ] && [ "$_ss_live" != 1 ]; then
    _ss_say "stopped at step $_ss_n/$_ss_total after $(_ss_dur $(($(_ss_now) - _ss_t0)))"
  fi
  screen_restore
  return "$_cl_rc"
}

# screen_init <version> <channel> <mode> <log-file> <area-name>...
screen_init() {
  _ss_version=$1
  _ss_channel=$2
  _ss_mode=$3
  _ss_log=${4:-/dev/null}
  if [ $# -ge 4 ]; then
    shift 4
  else
    shift $#
  fi
  _ss_plan=
  _ss_total=0
  for _in_a in "$@"; do
    _in_a=$(printf '%s' "$_in_a" | tr -d '\000-\037\177|')
    if [ -n "$_ss_plan" ]; then
      _ss_plan="$_ss_plan|$_in_a"
    else
      _ss_plan=$_in_a
    fi
    _ss_total=$((_ss_total + 1))
  done
  _ss_live=0
  if [ "${SCREEN_FORCE_TTY:-}" = 1 ] || [ -t 1 ]; then
    _ss_live=1
  fi
  if [ -n "${NO_COLOR:-}" ] || [ -z "${TERM:-}" ] || [ "${TERM:-}" = dumb ]; then
    _ss_live=0
  fi
  _ss_width
  _ss_setup_style
  : >>"$_ss_log" 2>/dev/null || _ss_log=/dev/null
  _ss_t0=$(_ss_now)
  _ss_n=0
  _ss_failed=0
  _ss_sum_open=0
  _ss_in=0
  _ss_items_out=0
  _ss_warns=0
  _ss_active=0
  _ss_drawn=0
  _ss_done_list=
  _ss_clear_subs
  _ss_ready=1
  _ss_cleaned=0
  _ss_logf "== installer $_ss_version channel=$_ss_channel mode=$_ss_mode"
  trap '_ss_cleanup' EXIT
  trap '_ss_sig 130' INT
  trap '_ss_sig 143' TERM
  trap '_ss_sig 129' HUP
  if [ "$_ss_live" = 1 ]; then
    printf '%s[?25l' "$_ss_ESC"
  fi
  _ss_header "$_ss_version" "$_ss_channel"
}

screen_area_start() {
  [ "$_ss_ready" = 1 ] || return 1
  if [ "$_ss_active" = 1 ]; then
    screen_area_done
  fi
  _ss_width
  _ss_n=$((_ss_n + 1))
  _ss_name=$(_ss_clean "$1" | tr -d '|')
  _ss_clear_subs
  _ss_frame=0
  _ss_active=1
  _ss_logf "== [$_ss_n/$_ss_total] $_ss_name"
  if [ "$_ss_live" = 1 ]; then
    _ss_paint
  else
    _ss_say "[$_ss_n/$_ss_total] $_ss_name ..."
  fi
}

# screen_sub <text> [<value>]: what the active area is doing. With a value the
# text is a key and the details line up in two columns.
screen_sub() {
  [ "$_ss_active" = 1 ] || return 0
  _sb_k=$(_ss_clean "$1")
  _sb_v=$(_ss_clean "${2:-}")
  if [ -n "$_sb_v" ]; then
    _ss_logf "   $_sb_k: $_sb_v"
  else
    _ss_logf "   $_sb_k"
  fi
  if [ "$_ss_live" = 1 ]; then
    _ss_put_sub "$_sb_k" "$_sb_v"
    _ss_paint
  elif [ -n "$_sb_v" ]; then
    _ss_say "      - $_sb_k: $_sb_v"
  else
    _ss_say "      - $_sb_k"
  fi
}

screen_area_done() {
  [ "$_ss_active" = 1 ] || return 0
  _d_det=$(_ss_clean "${1:-}")
  _d_el=$(_ss_dur $(($(_ss_now) - _ss_t0)))
  _ss_logf "-- ok: $_ss_name: $_d_det ($_d_el)"
  _ss_active=0
  if [ -n "$_ss_done_list" ]; then
    _ss_done_list="$_ss_done_list|$_ss_name"
  else
    _ss_done_list=$_ss_name
  fi
  if [ "$_ss_live" != 1 ]; then
    _ss_say "[$_ss_n/$_ss_total] ok   $_ss_name: $_d_det ($_d_el)"
  fi
}

# screen_area_fail <reason> [<next step>]: the active line turns red with a
# cross and keeps its detail lines; done and next stay, so it is clear where
# it stopped. The reason, the log path and one next step follow.
screen_area_fail() {
  [ "$_ss_active" = 1 ] || return 0
  _fl_why=$(_ss_clean "${1:-failed}")
  _fl_try=$(_ss_clean "${2:-fix the cause, then run the installer again}")
  _fl_el=$(_ss_dur $(($(_ss_now) - _ss_t0)))
  _ss_logf "-- FAILED: $_ss_name: $_fl_why ($_fl_el)"
  _ss_active=0
  _ss_failed=1
  if [ "$_ss_live" = 1 ]; then
    _ss_paint
    printf '%s' "$_ss_NL"
    printf '  %sfail%s  %s%s' "$_ss_BAD" "$_ss_RST" "$(_ss_fit "$_fl_why" $((_ss_cols - 1 - 8)))" "$_ss_NL"
    printf '  %slog%s   %s%s' "$_ss_DIM" "$_ss_RST" "$(_ss_fit "$_ss_log" $((_ss_cols - 1 - 8)))" "$_ss_NL"
    printf '  %stry%s   %s%s' "$_ss_DIM" "$_ss_RST" "$(_ss_fit "$_fl_try" $((_ss_cols - 1 - 8)))" "$_ss_NL"
    _ss_drawn=0
  else
    _ss_say "[$_ss_n/$_ss_total] FAIL $_ss_name: $_fl_why ($_fl_el)"
    _ss_say "      see $_ss_log"
    _ss_say "      next: $_fl_try"
  fi
}

# Run a real command with all of its output sent to the log file. The spinner
# keeps turning while it runs. Returns the command's exit status.
screen_run() {
  _ss_logf "\$ $*"
  if [ "$_ss_live" != 1 ] || [ "$_ss_active" != 1 ]; then
    "$@" >>"$_ss_log" 2>&1
    return $?
  fi
  "$@" >>"$_ss_log" 2>&1 &
  _ss_child=$!
  while kill -0 "$_ss_child" 2>/dev/null; do
    _ss_paint
    sleep 0.1 2>/dev/null || sleep 1
  done
  _ru_rc=0
  wait "$_ss_child" || _ru_rc=$?
  _ss_child=
  return "$_ru_rc"
}

# screen_summary <title>: the finish. The body and the header are replaced by
# the logo block with the title beside it and the total time.
screen_summary() {
  [ "$_ss_failed" = 0 ] || return 0
  if [ "$_ss_active" = 1 ]; then
    screen_area_done
  fi
  _sm_title=$(_ss_clean "$1")
  _sm_tot=$(_ss_dur $(($(_ss_now) - _ss_t0)))
  _ss_sum_open=1
  _ss_logf "== summary: $_sm_title ($_sm_tot)"
  if [ "$_ss_live" = 1 ]; then
    printf '%s[%sA%s%s[J' "$_ss_ESC" $((_ss_hdr_rows + _ss_drawn)) "$_ss_CR" "$_ss_ESC"
    _ss_drawn=0
    _sm_title=$(_ss_fit "$_sm_title" $(($(_ss_header_room) - 2 - ${#_sm_tot})))
    _ss_header_draw "${_ss_BOLD}${_sm_title}${_ss_RST}  ${_ss_DIM}${_sm_tot}${_ss_RST}"
  else
    _ss_say "== $_sm_title ($_sm_tot)"
  fi
}

# screen_summary_item <value> <note>: a URL or name with a short dim note.
screen_summary_item() {
  _si_v=$(_ss_clean "$1")
  _si_n=$(_ss_clean "${2:-}")
  if [ -n "$_si_n" ]; then
    _ss_logf "   $_si_v ($_si_n)"
  else
    _ss_logf "   $_si_v"
  fi
  if [ "$_ss_live" = 1 ]; then
    _ss_in=$((_ss_in + 1))
    eval "_ss_iv_$_ss_in=\$_si_v _ss_in_$_ss_in=\$_si_n"
  elif [ -n "$_si_n" ]; then
    _ss_say "   $_si_n: $_si_v"
  else
    _ss_say "   $_si_v"
  fi
}

# Print the buffered items aligned in two columns, then a blank line.
_ss_items_flush() {
  [ "$_ss_items_out" = 0 ] || return 0
  _ss_items_out=1
  [ "$_ss_in" -gt 0 ] || return 0
  _if_w=0
  _if_i=1
  while [ "$_if_i" -le "$_ss_in" ]; do
    eval "_if_v=\$_ss_iv_$_if_i"
    [ "${#_if_v}" -le "$_if_w" ] || _if_w=${#_if_v}
    _if_i=$((_if_i + 1))
  done
  [ "$_if_w" -le $((_ss_cols - 1 - 2)) ] || _if_w=$((_ss_cols - 1 - 2))
  _if_i=1
  while [ "$_if_i" -le "$_ss_in" ]; do
    eval "_if_v=\$_ss_iv_$_if_i _if_n=\$_ss_in_$_if_i"
    _if_room=$((_ss_cols - 1 - 2))
    _if_nr=$((_if_room - _if_w - 3))
    if [ "$_if_nr" -lt 1 ]; then
      _if_n=
    else
      _if_n=$(_ss_fit "$_if_n" "$_if_nr")
    fi
    _if_v=$(_ss_fit "$_if_v" "$_if_room")
    case $_if_v in
      http://* | https://*) _if_c=$_ss_LINK ;;
      *) _if_c=$_ss_BOLD ;;
    esac
    if [ -n "$_if_n" ]; then
      printf '  %s%s%s%s   %s%s%s%s' "$_if_c" "$_if_v" "$_ss_RST" "$(_ss_pad $((_if_w - ${#_if_v})))" \
        "$_ss_DIM" "$_if_n" "$_ss_RST" "$_ss_NL"
    else
      printf '  %s%s%s%s' "$_if_c" "$_if_v" "$_ss_RST" "$_ss_NL"
    fi
    _if_i=$((_if_i + 1))
  done
  printf '%s' "$_ss_NL"
}

screen_summary_warn() {
  _sw_t=$(_ss_clean "$1")
  _ss_logf "   warning: $_sw_t"
  if [ "$_ss_live" = 1 ]; then
    _ss_items_flush
    printf '  %s!%s %s%s' "$_ss_WARN" "$_ss_RST" "$(_ss_fit "$_sw_t" $((_ss_cols - 1 - 4)))" "$_ss_NL"
  else
    _ss_say "   warning: $_sw_t"
  fi
  _ss_warns=$((_ss_warns + 1))
}

screen_finish() {
  _fi_tot=$(_ss_dur $(($(_ss_now) - _ss_t0)))
  _ss_logf "== finished in $_fi_tot"
  if [ "$_ss_live" = 1 ]; then
    if [ "$_ss_sum_open" = 1 ]; then
      _ss_items_flush
      printf '  %slog%s  %s%s' "$_ss_DIM" "$_ss_RST" "$(_ss_fit "$_ss_log" $((_ss_cols - 1 - 7)))" "$_ss_NL"
    fi
  else
    _ss_say "log: $_ss_log"
    _ss_say "total: $_fi_tot"
  fi
  _ss_cleanup
}
