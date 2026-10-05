#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$repo_root"

if [ ! -d .agents/skills ]; then
  printf '%s\n' 'Missing .agents/skills in this checkout.' >&2
  exit 1
fi

if [ -L .claude/skills ] && [ "$(readlink .claude/skills)" = '../.agents/skills' ]; then
  exit 0
fi

if [ -e .claude/skills ] || [ -L .claude/skills ]; then
  printf '%s\n' 'Cannot create .claude/skills: the path already exists. Move it aside first.' >&2
  exit 1
fi

mkdir -p .claude
ln -s ../.agents/skills .claude/skills
printf '%s\n' 'Created .claude/skills -> ../.agents/skills'
