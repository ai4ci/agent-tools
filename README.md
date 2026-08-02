# agent-tools

tools for agents

This is a monorepo providing collections of custom tools that can be loaded
into claude code or pi and provide functions:

## Remote explorer

allows read and search functions (ls, grep, find, ripgrep - if available) on remote machines
over SSH. Lets your agent explore what is installed on a remote machine. Tools
consult .aiignore and wrap operations in bubblewrap (bwrap) with a ro_bind and
very limited bash tools via configurable whitelist. requires passwordless ssh access.




