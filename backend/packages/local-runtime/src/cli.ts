#!/usr/bin/env node
/**
 * Miriad Backend CLI
 *
 * Run Miriad agents on your local machine, container, or VPS.
 *
 * Commands:
 *   auth <connection-string>  - Authenticate with Miriad
 *   start [--name <name>]     - Start the runtime
 *   status                    - Show runtime status
 *   agents                    - List active agents
 */

import { RuntimeClient } from './runtime-client.js';
import {
  loadConfig,
  initFromConnectionString,
  getConfigPath,
} from './config.js';

// =============================================================================
// Help Text
// =============================================================================

const HELP = `
Miriad Backend - Run Miriad agents on your local machine, container, or VPS

Usage:
  npx @miriad-systems/backend auth <connection-string>   Authenticate with Miriad
  npx @miriad-systems/backend start [options]            Start the runtime
  npx @miriad-systems/backend status                     Show runtime status
  npx @miriad-systems/backend agents                     List active agents
  npx @miriad-systems/backend help                       Show this help message

Commands:
  auth <connection-string>
    Authenticate with Miriad using a connection string from the UI.
    Example: npx @miriad-systems/backend auth "cast://bst_xxx@api.miriad.systems/space_abc"

  start [--name <name>] [--idle-timeout <minutes>]
    Start the runtime and connect to Miriad.
    Options:
      --name <name>              Runtime name (default: hostname)
      --idle-timeout <minutes>   Exit after N minutes of inactivity (default: never)

  status
    Show the runtime configuration and connection status.

  agents
    List all active agents on this runtime.

Configuration:
  Config is stored at: ~/.config/miriad/config.json
  Agent workspaces: ~/miriad-workspaces/

Environment Variables:
  ANTHROPIC_API_KEY    Required for Claude Agent SDK
  MIRIAD_CONFIG_DIR    Override config directory (default: ~/.config/miriad)
                       Useful for running dev and prod instances side by side:
                       MIRIAD_CONFIG_DIR=~/.config/miriad-dev npx @miriad-systems/backend start
`;

// =============================================================================
// Commands
// =============================================================================

async function cmdAuth(args: string[]): Promise<void> {
  const connectionString = args[0];

  if (!connectionString) {
    console.error('Error: Connection string required');
    console.error('Usage: npx @miriad-systems/backend auth "cast://bst_xxx@api.cast.dev/space_abc"');
    process.exit(1);
  }

  // Check for --name flag
  let name: string | undefined;
  const nameIdx = args.indexOf('--name');
  if (nameIdx !== -1 && args[nameIdx + 1]) {
    name = args[nameIdx + 1];
  }

  try {
    await initFromConnectionString(connectionString, name);
    console.log('\nAuthentication successful!');
    console.log('Run "npx @miriad-systems/backend start" to connect.');
  } catch (error) {
    console.error('Authentication failed:', (error as Error).message);
    process.exit(1);
  }
}

async function cmdStart(args: string[]): Promise<void> {
  // Validate API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
  }

  // Load config
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Not authenticated. Run "npx @miriad-systems/backend auth" first.');
    process.exit(1);
  }

  // Check for --name flag to override
  const nameIdx = args.indexOf('--name');
  if (nameIdx !== -1 && args[nameIdx + 1]) {
    config.name = args[nameIdx + 1];
  }

  // Check for --idle-timeout flag
  let idleTimeoutMinutes: number | undefined;
  const idleIdx = args.indexOf('--idle-timeout');
  if (idleIdx !== -1 && args[idleIdx + 1]) {
    idleTimeoutMinutes = parseInt(args[idleIdx + 1], 10);
    if (isNaN(idleTimeoutMinutes) || idleTimeoutMinutes <= 0) {
      console.error('Error: --idle-timeout must be a positive number of minutes');
      process.exit(1);
    }
  }

  console.log('Starting local runtime...');
  console.log(`  Runtime: ${config.name} (${config.credentials.runtimeId})`);
  console.log(`  Space: ${config.spaceId}`);
  console.log(`  Workspace: ${config.workspace.basePath}`);
  if (idleTimeoutMinutes) {
    console.log(`  Idle timeout: ${idleTimeoutMinutes} minutes`);
  }
  console.log();

  // Create and connect runtime client
  const client = new RuntimeClient({
    config,
    idleTimeoutMinutes,
    onConnected: () => {
      console.log('Runtime ready. Waiting for agents...');
    },
    onDisconnected: (code, reason) => {
      console.log(`Disconnected: ${code} ${reason}`);
    },
    onError: () => {
      // Error already logged by RuntimeClient with clean formatting
    },
    onIdleTimeout: () => {
      console.log(`\nIdle timeout (${idleTimeoutMinutes} minutes) - shutting down...`);
      process.exit(0);
    },
  });

  // Handle shutdown signals
  const shutdown = async () => {
    console.log('\nShutting down...');
    await client.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await client.connect();
    // Keep process alive
    console.log('Press Ctrl+C to stop.');
  } catch {
    // Error already logged by RuntimeClient
    // Don't exit - let reconnection handle it
  }
}

async function cmdStatus(): Promise<void> {
  const config = await loadConfig();

  if (!config) {
    console.log('Status: Not configured');
    console.log(`Config file: ${getConfigPath()}`);
    console.log('\nRun "npx @miriad-systems/backend auth" to configure.');
    return;
  }

  console.log('Local Runtime Status');
  console.log('====================');
  console.log();
  console.log(`Runtime ID:    ${config.credentials.runtimeId}`);
  console.log(`Runtime Name:  ${config.name}`);
  console.log(`Space:         ${config.spaceId}`);
  console.log(`Server:        ${config.credentials.serverId}`);
  console.log(`API URL:       ${config.credentials.apiUrl}`);
  console.log(`WebSocket URL: ${config.credentials.wsUrl}`);
  console.log(`Workspace:     ${config.workspace.basePath}`);
  console.log(`Configured:    ${config.createdAt}`);
  console.log();
  console.log(`Config file: ${getConfigPath()}`);
  console.log();
  console.log('Note: To see active agents, start the runtime and check the UI.');
}

async function cmdAgents(): Promise<void> {
  const config = await loadConfig();

  if (!config) {
    console.error('Error: Not configured. Run "npx @miriad-systems/backend auth" first.');
    process.exit(1);
  }

  console.log('Active Agents');
  console.log('=============');
  console.log();
  console.log('Note: This command shows agents only when the runtime is running.');
  console.log('Use "npx @miriad-systems/backend start" to start the runtime first.');
  console.log();
  console.log('To see agent status, check the CAST UI or runtime logs.');
}

function cmdHelp(): void {
  console.log(HELP);
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    cmdHelp();
    process.exit(0);
  }

  switch (command) {
    case 'auth':
      await cmdAuth(args.slice(1));
      break;

    case 'start':
      await cmdStart(args.slice(1));
      break;

    case 'status':
      await cmdStatus();
      break;

    case 'agents':
      await cmdAgents();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "npx @miriad-systems/backend help" for usage.');
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
