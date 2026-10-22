import { OrcaRuntimeWithTerminalDrivers } from '../terminal/driver/terminal-driver-resources'
import { ClaudeAgentTeamsService } from '../claude-agent-teams-service'
import { ClaudeAgentTeamsTelegramBridge } from '../claude-agent-teams-telegram-bridge'

function createClaudeAgentTeamsRuntimeWiring(): {
  telegramBridge: ClaudeAgentTeamsTelegramBridge
  agentTeams: ClaudeAgentTeamsService
} {
  const telegramBridge = new ClaudeAgentTeamsTelegramBridge()
  const agentTeams = new ClaudeAgentTeamsService()
  agentTeams.setTeamRemovedListener((team) => telegramBridge.stop(team.teamId))
  return { telegramBridge, agentTeams }
}

// Why a free function, not a constructor: wiring a team's eviction to stop its bridge here,
// instead of overriding this class's constructor, keeps this out of the per-mixin
// constructor-parity audit (runtime-composition-parity.test.ts).
export abstract class OrcaRuntimeWithClaudeAgentTeamsTelegramWiring extends OrcaRuntimeWithTerminalDrivers {
  private readonly claudeAgentTeamsWiring = createClaudeAgentTeamsRuntimeWiring()
  protected readonly claudeAgentTeamsTelegramBridge = this.claudeAgentTeamsWiring.telegramBridge
  protected readonly claudeAgentTeams = this.claudeAgentTeamsWiring.agentTeams
}
