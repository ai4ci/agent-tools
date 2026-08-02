import { Type } from 'typebox'
import { type ToolDefinition, type ToolResult, toolError } from '../tool.js'

/**
 * List the hosts this agent may explore.
 *
 * Exists so a model can discover valid aliases rather than guessing at them. It
 * reads configuration only and never touches the network, so it stays cheap and
 * cannot fail because a host is down.
 */
export const remoteHosts: ToolDefinition = {
  name: 'remote_hosts',
  label: 'Remote hosts',
  description:
    'List the remote hosts that are configured for exploration, with the root directory ' +
    'each one is limited to. Call this first if you do not already know a host alias: ' +
    'every other remote tool takes an alias from this list, and no other host can be reached.',
  parameters: Type.Object({}),

  handler(_params, context): Promise<ToolResult> {
    try {
      const hosts = context.hosts()

      if (hosts.length === 0) {
        return Promise.resolve({
          text:
            'No hosts are configured, so no remote exploration is possible. ' +
            'An operator must add hosts to the agent-tools configuration file.',
          details: { hosts: [] },
        })
      }

      const lines = hosts.map((host) => `${host.alias}\troot: ${host.root}`)
      return Promise.resolve({
        text: `${hosts.length} configured host${hosts.length === 1 ? '' : 's'}:\n${lines.join('\n')}`,
        details: { hosts },
      })
    } catch (error) {
      return Promise.resolve(toolError(error))
    }
  },
}
