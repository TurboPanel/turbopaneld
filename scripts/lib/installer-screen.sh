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
#   screen_init <version> <channel> <mode> <total-areas> <log-file>
#       mode is "daemon" or "panel". Draws the header, hides the cursor and
#       installs the INT, TERM, HUP and EXIT handlers that restore it.
#   screen_area_start <name>     open an area: bold title, spinner, sub-lines
#   screen_sub <text>            what the active area is doing right now
#                                (rolling window of 3 lines, not a log)
#   screen_run <cmd> [args...]   run a real command: output goes to the log
#                                file, the spinner keeps turning meanwhile
#   screen_area_done [detail]    collapse to one line: check, name, detail, time
#   screen_area_fail <reason>    collapse to a cross and a one-line reason
#   screen_summary <title>       final panel header (prints the closing bar first)
#   screen_summary_item <label> <value>
#   screen_summary_warn <text>   warnings to act on (after the items)
#   screen_finish                log path, total time, cursor restored
#   screen_restore               restore the terminal only (for a caller's own
#                                EXIT trap; screen_init already installs one)
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
_ss_bar_done=0
_ss_sum_open=0
_ss_warns=0
_ss_n=0
_ss_total=0
_ss_done_n=0
_ss_frame=0
_ss_cols=0
_ss_name=
_ss_s1=
_ss_s2=
_ss_s3=
_ss_log=/dev/null
_ss_t0=0
_ss_a0=0

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

# _ss_dur <seconds>: 12s, 1m05s
_ss_dur() {
  if [ "$1" -lt 60 ]; then
    printf '%ss' "$1"
  else
    printf '%sm%02ds' $(($1 / 60)) $(($1 % 60))
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
    _ss_ok='✓'
    _ss_no='✗'
    _ss_arrow='›'
    _ss_fill='━'
    _ss_rest='─'
    _ss_rail_top='╭─'
    _ss_rail='│'
    _ss_rail_end='╰─'
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
    _ss_ok='+'
    _ss_no='x'
    _ss_arrow='>'
    _ss_fill='#'
    _ss_rest='-'
    _ss_rail_top='+-'
    _ss_rail='|'
    _ss_rail_end='+-'
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

_ss_header() {
  _h_ver=$(_ss_clean "$1")
  _h_ch=$(_ss_clean "$2")
  if [ "$_ss_live" != 1 ]; then
    _ss_say "TurboPanel installer $_h_ver (channel $_h_ch, mode $(_ss_mode_label))"
    _ss_say "log: $_ss_log"
    return 0
  fi
  _h_room=$((_ss_cols - 1 - 18 - 3))
  _h_l1="${_ss_BOLD}TurboPanel${_ss_RST} ${_ss_DIM}installer${_ss_RST}"
  _h_l2="$(_ss_fit "v$_h_ver" "$_h_room")"
  _h_l2="${_ss_BOLD}${_h_l2}${_ss_RST}"
  _h_ch=$(_ss_fit "channel $_h_ch" $((_h_room - 12)))
  _h_l3="${_ss_DIM}${_h_ch}${_ss_RST}"
  _h_l4="${_ss_DIM}mode${_ss_RST} ${_ss_LINK}$(_ss_mode_label)${_ss_RST}"
  if [ "$_ss_utf" = 1 ]; then
    printf '%s' "$_ss_NL"
    printf ' %s   %s%s' "$(_ss_logo_row 0)" "" "$_ss_NL"
    printf ' %s   %s%s' "$(_ss_logo_row 1)" "$_h_l1" "$_ss_NL"
    printf ' %s   %s  %s%s' "$(_ss_logo_row 2)" "$_h_l2" "$_h_l3" "$_ss_NL"
    printf ' %s   %s%s' "$(_ss_logo_row 3)" "$_h_l4" "$_ss_NL"
    printf ' %s%s' "$(_ss_logo_row 4)" "$_ss_NL"
    printf '%s' "$_ss_NL"
  else
    printf '%s %s  %s  %s%s' "$_ss_NL" "$_h_l1" "$_h_l2" "$_h_l3" "$_ss_NL"
    printf ' %s%s%s' "$_h_l4" "$_ss_NL" "$_ss_NL"
  fi
}

# Region rows: title, three sub-lines, a spacer and the progress bar.
_ss_title_row() {
  _t_spin=$(eval "printf '%s' \"\$_ss_spin_$((_ss_frame % _ss_spin_n + 1))\"")
  _t_el=$(_ss_dur $(($(_ss_now) - _ss_a0)))
  _t_room=$((_ss_cols - 1 - 3 - ${#_t_el} - 2))
  _t_nm=$(_ss_fit "$_ss_name" "$_t_room")
  _t_gap=$((_ss_cols - 1 - 3 - ${#_t_nm} - ${#_t_el}))
  printf ' %s%s%s %s%s%s%s%s%s%s' "$_ss_BLUE" "$_t_spin" "$_ss_RST" \
    "$_ss_BOLD" "$_t_nm" "$_ss_RST" "$(_ss_pad "$_t_gap")" "$_ss_DIM" "$_t_el" "$_ss_RST"
}

_ss_sub_row() {
  # $1 text, $2 1 when it is the newest line
  [ -n "$1" ] || return 0
  if [ "$2" = 1 ]; then
    printf '    %s%s%s %s%s%s' "$_ss_LINK" "$_ss_arrow" "$_ss_RST" "$_ss_DIM" "$1" "$_ss_RST"
  else
    printf '      %s%s%s' "$_ss_DIM" "$1" "$_ss_RST"
  fi
}

# _ss_bar_row <tone-color>: progress bar with step n/N and the total time.
_ss_bar_row() {
  _b_step="$_ss_done_n/$_ss_total"
  _b_tot=$(_ss_dur $(($(_ss_now) - _ss_t0)))
  _b_len=$((2 + ${#_b_step} + 2 + ${#_b_tot}))
  _b_w=$((_ss_cols - 2 - _b_len))
  [ "$_b_w" -le 32 ] || _b_w=32
  _b_f=0
  [ "$_ss_total" -le 0 ] || _b_f=$((_ss_done_n * _b_w / _ss_total))
  _b_head=
  _b_tail=
  _b_i=0
  while [ "$_b_i" -lt "$_b_w" ]; do
    if [ "$_b_i" -lt "$_b_f" ]; then
      _b_head="$_b_head$_ss_fill"
    else
      _b_tail="$_b_tail$_ss_rest"
    fi
    _b_i=$((_b_i + 1))
  done
  printf ' %s%s%s%s%s%s  %s%s%s  %s%s%s' "$1" "$_b_head" "$_ss_RST" \
    "$_ss_DIM" "$_b_tail" "$_ss_RST" "$_ss_BOLD" "$_b_step" "$_ss_RST" "$_ss_DIM" "$_b_tot" "$_ss_RST"
}

# Repaint the active block in place: move up over what was drawn, rewrite it.
_ss_paint() {
  [ "$_ss_live" = 1 ] && [ "$_ss_active" = 1 ] || return 0
  _p_o=
  if [ "$_ss_drawn" -gt 0 ]; then
    _p_o="${_ss_ESC}[${_ss_drawn}A"
  fi
  _p_k="${_ss_ESC}[2K"
  _p_o="${_p_o}${_ss_CR}${_p_k}$(_ss_title_row)${_ss_NL}"
  _p_o="${_p_o}${_p_k}$(_ss_sub_row "$_ss_s1" 0)${_ss_NL}"
  _p_o="${_p_o}${_p_k}$(_ss_sub_row "$_ss_s2" 0)${_ss_NL}"
  _p_o="${_p_o}${_p_k}$(_ss_sub_row "$_ss_s3" 1)${_ss_NL}"
  _p_o="${_p_o}${_p_k}${_ss_NL}"
  _p_o="${_p_o}${_p_k}$(_ss_bar_row "$_ss_BLUE")${_ss_NL}"
  printf '%s' "$_p_o"
  _ss_drawn=6
  _ss_frame=$((_ss_frame + 1))
}

# Replace the active block with one finished line (or two, for a failure).
_ss_collapse() {
  _c_o=
  if [ "$_ss_drawn" -gt 0 ]; then
    _c_o="${_ss_ESC}[${_ss_drawn}A"
  fi
  printf '%s%s%s[2K%s%s%s[J' "$_c_o" "$_ss_CR" "$_ss_ESC" "$1" "$_ss_NL" "$_ss_ESC"
  if [ -n "$2" ]; then
    printf '%s[2K%s%s' "$_ss_ESC" "$2" "$_ss_NL"
  fi
  _ss_drawn=0
}

# _ss_result_row <glyph> <glyph-color> <detail> <detail-color> <elapsed>
_ss_result_row() {
  _r_nw=18
  [ "$_ss_cols" -ge 80 ] || _r_nw=14
  _r_name=$(_ss_fit "$_ss_name" "$_r_nw")
  _r_dw=$((_ss_cols - 1 - 3 - _r_nw - 2 - 2 - 6))
  _r_det=$(_ss_fit "$3" "$_r_dw")
  _r_padn=$((_r_nw - ${#_r_name}))
  _r_padd=$((_r_dw - ${#_r_det}))
  printf ' %s%s%s %s%s%s%s  %s%s%s%s  %s%6s%s' "$2" "$1" "$_ss_RST" \
    "$_ss_BOLD" "$_r_name" "$_ss_RST" "$(_ss_pad "$_r_padn")" \
    "$4" "$_r_det" "$_ss_RST" "$(_ss_pad "$_r_padd")" "$_ss_DIM" "$5" "$_ss_RST"
}

_ss_push_sub() {
  _ss_s1=$_ss_s2
  _ss_s2=$_ss_s3
  _ss_s3=$1
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

# The closing progress line: filled to the finished steps, green or red.
_ss_final_bar() {
  [ "$_ss_bar_done" = 0 ] || return 0
  _ss_bar_done=1
  _ss_name=
  if [ "$_ss_live" = 1 ]; then
    if [ "$_ss_failed" = 1 ]; then
      printf '%s%s%s' "$_ss_NL" "$(_ss_bar_row "$_ss_BAD")" "$_ss_NL"
    else
      printf '%s%s%s' "$_ss_NL" "$(_ss_bar_row "$_ss_GREEN")" "$_ss_NL"
    fi
  elif [ "$_ss_failed" = 1 ]; then
    _ss_say "stopped at step $_ss_n/$_ss_total after $(_ss_dur $(($(_ss_now) - _ss_t0)))"
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
  if [ "$_ss_ready" = 1 ]; then
    _ss_final_bar
  fi
  screen_restore
  return "$_cl_rc"
}

screen_init() {
  _ss_version=$1
  _ss_channel=$2
  _ss_mode=$3
  _ss_total=$4
  _ss_log=${5:-/dev/null}
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
  _ss_done_n=0
  _ss_failed=0
  _ss_bar_done=0
  _ss_sum_open=0
  _ss_warns=0
  _ss_active=0
  _ss_drawn=0
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
  _ss_name=$(_ss_clean "$1")
  _ss_s1=
  _ss_s2=
  _ss_s3=
  _ss_frame=0
  _ss_a0=$(_ss_now)
  _ss_active=1
  _ss_drawn=0
  _ss_logf "== [$_ss_n/$_ss_total] $_ss_name"
  if [ "$_ss_live" = 1 ]; then
    _ss_paint
  else
    _ss_say "[$_ss_n/$_ss_total] $_ss_name ..."
  fi
}

screen_sub() {
  [ "$_ss_active" = 1 ] || return 0
  _sb_t=$(_ss_clean "$1")
  _ss_logf "   $_sb_t"
  if [ "$_ss_live" = 1 ]; then
    _ss_push_sub "$(_ss_fit "$_sb_t" $((_ss_cols - 1 - 6)))"
    _ss_paint
  else
    _ss_say "      - $_sb_t"
  fi
}

screen_area_done() {
  [ "$_ss_active" = 1 ] || return 0
  _d_det=$(_ss_clean "${1:-}")
  _d_el=$(_ss_dur $(($(_ss_now) - _ss_a0)))
  _ss_logf "-- ok: $_ss_name: $_d_det ($_d_el)"
  _ss_active=0
  _ss_done_n=$((_ss_done_n + 1))
  if [ "$_ss_live" = 1 ]; then
    _ss_collapse "$(_ss_result_row "$_ss_ok" "$_ss_GREEN" "$_d_det" "$_ss_DIM" "$_d_el")" ''
  else
    _ss_say "[$_ss_n/$_ss_total] ok   $_ss_name: $_d_det ($_d_el)"
  fi
}

screen_area_fail() {
  [ "$_ss_active" = 1 ] || return 0
  _fl_why=$(_ss_clean "${1:-failed}")
  _fl_el=$(_ss_dur $(($(_ss_now) - _ss_a0)))
  _ss_logf "-- FAILED: $_ss_name: $_fl_why ($_fl_el)"
  _ss_active=0
  _ss_failed=1
  if [ "$_ss_live" = 1 ]; then
    _fl_hint=$(_ss_fit "see $_ss_log" $((_ss_cols - 1 - 6)))
    _ss_collapse "$(_ss_result_row "$_ss_no" "$_ss_BAD" "$_fl_why" "$_ss_BAD" "$_fl_el")" \
      "      ${_ss_DIM}${_fl_hint}${_ss_RST}"
  else
    _ss_say "[$_ss_n/$_ss_total] FAIL $_ss_name: $_fl_why ($_fl_el)"
    _ss_say "      see $_ss_log"
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

screen_summary() {
  _ss_final_bar
  _sm_title=$(_ss_clean "$1")
  _sm_tot=$(_ss_dur $(($(_ss_now) - _ss_t0)))
  _ss_sum_open=1
  _ss_logf "== summary: $_sm_title ($_sm_tot)"
  if [ "$_ss_live" = 1 ]; then
    _sm_title=$(_ss_fit "$_sm_title" $((_ss_cols - 1 - 4 - 2 - ${#_sm_tot})))
    printf ' %s%s%s %s%s%s  %s%s%s%s' "$_ss_GREEN" "$_ss_rail_top" "$_ss_RST" \
      "$_ss_BOLD" "$_sm_title" "$_ss_RST" "$_ss_DIM" "$_sm_tot" "$_ss_RST" "$_ss_NL"
    printf ' %s%s%s%s' "$_ss_GREEN" "$_ss_rail" "$_ss_RST" "$_ss_NL"
  else
    _ss_say "== $_sm_title ($_sm_tot)"
  fi
}

screen_summary_item() {
  _si_k=$(_ss_clean "$1")
  _si_v=$(_ss_clean "$2")
  _ss_logf "   $_si_k: $_si_v"
  if [ "$_ss_live" = 1 ]; then
    _si_k=$(_ss_fit "$_si_k" 9)
    _si_v=$(_ss_fit "$_si_v" $((_ss_cols - 1 - 4 - 11)))
    case $_si_v in
      http://* | https://*) _si_c=$_ss_LINK ;;
      *) _si_c=$_ss_BOLD ;;
    esac
    printf ' %s%s%s  %s%-9s%s  %s%s%s%s' "$_ss_GREEN" "$_ss_rail" "$_ss_RST" \
      "$_ss_DIM" "$_si_k" "$_ss_RST" "$_si_c" "$_si_v" "$_ss_RST" "$_ss_NL"
  else
    _ss_say "   $_si_k: $_si_v"
  fi
}

screen_summary_warn() {
  _sw_t=$(_ss_clean "$1")
  _ss_logf "   warning: $_sw_t"
  if [ "$_ss_live" = 1 ]; then
    if [ "$_ss_warns" = 0 ]; then
      printf ' %s%s%s%s' "$_ss_GREEN" "$_ss_rail" "$_ss_RST" "$_ss_NL"
      printf ' %s%s%s  %sTo do%s%s' "$_ss_GREEN" "$_ss_rail" "$_ss_RST" "$_ss_WARN" "$_ss_RST" "$_ss_NL"
    fi
    _sw_t=$(_ss_fit "$_sw_t" $((_ss_cols - 1 - 4 - 2)))
    printf ' %s%s%s  %s!%s %s%s' "$_ss_GREEN" "$_ss_rail" "$_ss_RST" "$_ss_WARN" "$_ss_RST" "$_sw_t" "$_ss_NL"
  else
    _ss_say "   warning: $_sw_t"
  fi
  _ss_warns=$((_ss_warns + 1))
}

screen_finish() {
  _ss_final_bar
  _fi_tot=$(_ss_dur $(($(_ss_now) - _ss_t0)))
  _ss_logf "== finished in $_fi_tot"
  if [ "$_ss_live" = 1 ]; then
    if [ "$_ss_sum_open" = 1 ]; then
      _fi_log=$(_ss_fit "$_ss_log" $((_ss_cols - 1 - 4 - 11)))
      printf ' %s%s%s%s' "$_ss_GREEN" "$_ss_rail" "$_ss_RST" "$_ss_NL"
      printf ' %s%s%s  %s%-9s%s  %s%s%s%s' "$_ss_GREEN" "$_ss_rail" "$_ss_RST" \
        "$_ss_DIM" "log" "$_ss_RST" "$_ss_DIM" "$_fi_log" "$_ss_RST" "$_ss_NL"
      printf ' %s%s%s%s' "$_ss_GREEN" "$_ss_rail_end" "$_ss_RST" "$_ss_NL"
    fi
  else
    _ss_say "log: $_ss_log"
    _ss_say "total: $_fi_tot"
  fi
  _ss_cleanup
}
