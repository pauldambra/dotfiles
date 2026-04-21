# Development Tools Initialization

# atuin - shell history
if [ -f "$HOME/.atuin/bin/env" ]; then
  . "$HOME/.atuin/bin/env"
  eval "$(atuin init zsh)"
fi

# nvm - Node Version Manager
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# pyenv - Python Version Manager
export PYENV_ROOT="$HOME/.pyenv"
[[ -d $PYENV_ROOT/bin ]] && export PATH="$PYENV_ROOT/bin:$PATH"
if command -v pyenv 1>/dev/null 2>&1; then
  eval "$(pyenv init -)"
fi

# rbenv - Ruby Version Manager
if command -v rbenv 1>/dev/null 2>&1; then
  eval "$(rbenv init -)"
  export PATH="$HOME/.rbenv/shims:$PATH"
fi

# direnv - environment switcher
if command -v direnv 1>/dev/null 2>&1; then
  eval "$(direnv hook zsh)"
fi

# pnpm - Package Manager
export PNPM_HOME="/Users/pauldambra/Library/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac

# Claude CLI
if [ -f "/Users/pauldambra/.claude/local/claude" ]; then
  alias claude="/Users/pauldambra/.claude/local/claude"
fi

# Deno
[ -f "$HOME/.deno/env" ] && . "$HOME/.deno/env"

# Local bin directory
[ -d "$HOME/.local/bin" ] && . "$HOME/.local/bin/env"
