# CCC (see .zshenv here): the person's own .zshrc, then the marks around each command
ZDOTDIR="$CCC_USER_ZDOTDIR"
# the Mac's /etc/zshrc put the history beside these files: it goes where the person keeps it
[[ "$HISTFILE" == "$CCC_ZDOTDIR"/* ]] && HISTFILE="$ZDOTDIR/.zsh_history"
[[ -f "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
# from here on zsh is as if CCC had never been in between
[[ "$ZDOTDIR" == "$HOME" ]] && unset ZDOTDIR
unset CCC_ZDOTDIR CCC_USER_ZDOTDIR

__ccc_preexec() { printf '\e]7770;ccc;start\a' }
# first, so it reads the exit code before anything else at the prompt changes it
__ccc_precmd() { printf '\e]7770;ccc;done;%s\a' "$?" }
preexec_functions+=(__ccc_preexec)
precmd_functions=(__ccc_precmd $precmd_functions)
