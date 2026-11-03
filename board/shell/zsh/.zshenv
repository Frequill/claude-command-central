# CCC: how the terminal a chat's Run commands go to starts, when it is zsh (serve.py run_shell).
# zsh reads its start files from this folder (ZDOTDIR): each reads the person's own first, and
# .zshrc then marks where each command starts and ends, with codes a terminal does not show. CCC
# reads from them what a Run printed and how it ended.
CCC_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="${CCC_USER_ZDOTDIR:-$HOME}"
[[ -f "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
# the person's .zshenv may keep their start files elsewhere
CCC_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$CCC_ZDOTDIR"
