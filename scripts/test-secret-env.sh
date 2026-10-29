#!/usr/bin/env bash
# Sourced by test boundaries. Shell keeps this policy in the runner process;
# a child process cannot remove variables from its parent's environment.
tap_test_scrub_secrets() {
  local name
  # compgen emits names only: env/printenv would serialize secret values,
  # including multiline values that cannot safely be parsed one line at a time.
  while IFS= read -r name; do
    case "$name" in
      *_TOKEN|*_API_KEY|*_SECRET|*_PASSWORD|*_CREDENTIALS|\
      TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIALS|\
      AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AZURE_OPENAI_KEY|\
      SSH_PRIVATE_KEY|SSH_KEY|AUTH_COOKIE|HF_TOKENS|DIRENV_DIFF)
        unset "$name" || return 1 ;;
    esac
  done < <(compgen -e)
}
tap_test_scrub_secrets || return 1
unset -f tap_test_scrub_secrets
