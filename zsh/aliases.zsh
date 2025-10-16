# Pytest
alias pytest-changes='git bchanges | grep "test_[^/]*\.py$" | xargs pytest'

# Disk Space Management
alias disk-check='~/dotfiles/bin/check-disk-space'
alias disk-free='~/dotfiles/bin/free-disk-space'
alias disk-usage='df -h'
alias disk-cleanup-docker='docker system prune -a -f --volumes'
alias disk-cleanup-caches='rm -rf ~/.cache/uv ~/.cache/puppeteer ~/Library/Caches/JetBrains ~/Library/Caches/Google/Chrome/Default/Cache'
