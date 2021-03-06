/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter, IDisposable } from '../../common/events';
import Cdp from '../../cdp/api';
import Connection from '../../cdp/connection';
import { PipeTransport } from '../../cdp/transport';
import {
  ILauncher,
  ITarget,
  ILaunchResult,
  ILaunchContext,
  IStopMetadata,
} from '../../targets/targets';
import { AnyLaunchConfiguration, AnyNodeConfiguration } from '../../configuration';
import { EnvironmentVars } from '../../common/environmentVars';
import { INodeTargetLifecycleHooks, NodeTarget } from './nodeTarget';
import { NodeSourcePathResolver } from './nodeSourcePathResolver';
import { IProgram } from './program';
import { ProtocolError, cannotLoadEnvironmentVars } from '../../dap/errors';
import { ObservableMap } from '../targetList';
import { findInPath } from '../../common/pathUtils';
import { TelemetryReporter } from '../../telemetry/telemetryReporter';
import { NodePathProvider, INodePathProvider } from './nodePathProvider';
import { ILogger } from '../../common/logging';
import { inject, injectable } from 'inversify';

/**
 * Telemetry received from the nested process.
 */
export interface IProcessTelemetry {
  /**
   * Target process ID.
   */
  processId: number;

  /**
   * Process node version.
   */
  nodeVersion: string;

  /**
   * CPU architecture.
   */
  architecture: string;
}

type BootloaderFile = IDisposable & { path: string };

/**
 * Data stored for a currently running debug session within the Node launcher.
 */
export interface IRunData<T> {
  server: net.Server;
  serverAddress: string;
  bootloader: BootloaderFile;
  pathResolver: NodeSourcePathResolver;
  context: ILaunchContext;
  params: T;
}

let counter = 0;

@injectable()
export abstract class NodeLauncherBase<T extends AnyNodeConfiguration> implements ILauncher {
  /**
   * Data set while a debug session is running.
   */
  protected run?: IRunData<T>;

  /**
   * Attached server connections. Tracked so they can be torn down readily.
   */
  private serverConnections: Connection[] = [];

  /**
   * Target list.
   */
  private readonly targets = new ObservableMap<string, NodeTarget>();

  /**
   * Underlying emitter fired when sessions terminate. Listened to by the
   * binder and used to trigger a `terminate` message on the DAP.
   */
  private onTerminatedEmitter = new EventEmitter<IStopMetadata>();

  /**
   * @inheritdoc
   */
  public readonly onTerminated = this.onTerminatedEmitter.event;

  /**
   * @inheritdoc
   */
  public readonly onTargetListChanged = this.targets.onChanged;

  /**
   * The currently running program. Set to undefined if there's no process
   * running.
   */
  protected program?: IProgram;

  constructor(
    @inject(INodePathProvider) private readonly pathProvider: NodePathProvider,
    @inject(ILogger) protected readonly logger: ILogger,
  ) {}

  /**
   * @inheritdoc
   */
  public async launch(
    params: AnyLaunchConfiguration,
    context: ILaunchContext,
  ): Promise<ILaunchResult> {
    const resolved = this.resolveParams(params);
    if (!resolved) {
      return { blockSessionTermination: false };
    }

    this._stopServer(); // clear any ongoing run

    const { server, pipe } = await this._startServer(context.telemetryReporter);
    const run = (this.run = {
      server,
      serverAddress: pipe,
      params: resolved,
      context,
      bootloader: this.getBootloaderFile(resolved.cwd),
      pathResolver: new NodeSourcePathResolver(
        {
          resolveSourceMapLocations: resolved.resolveSourceMapLocations,
          basePath: resolved.cwd,
          sourceMapOverrides: resolved.sourceMapPathOverrides,
          remoteRoot: resolved.remoteRoot,
          localRoot: resolved.localRoot,
        },
        this.logger,
      ),
    });

    const error = await this.launchProgram(run);
    return error ? { error } : { blockSessionTermination: true };
  }

  /**
   * @inheritdoc
   */
  public async terminate(): Promise<void> {
    if (this.program) {
      await this.program.stop();
    } else {
      this.onProgramTerminated({ code: 0, killed: true });
    }
  }

  /**
   * @inheritdoc
   */
  public async disconnect(): Promise<void> {
    await this.terminate();
  }

  /**
   * Restarts the ongoing program.
   */
  public async restart(): Promise<void> {
    if (!this.run) {
      return;
    }

    // connections must be closed, or the process will wait forever:
    this.closeAllConnections();

    // relaunch the program:
    await this.launchProgram(this.run);
  }

  public targetList(): ITarget[] {
    return [...this.targets.value()];
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this._stopServer();
  }

  /**
   * Returns the params type if they can be launched by this launcher,
   * or undefined if they cannot.
   */
  protected abstract resolveParams(params: AnyLaunchConfiguration): T | undefined;

  /**
   * Launches the program. Called after the server is running and upon restart.
   */
  protected abstract launchProgram(runData: IRunData<T>): Promise<string | void>;

  /**
   * Method that should be called when the program from launchProgram() exits.
   * Emits a stop to the client and tears down the server.
   */
  protected onProgramTerminated(result: IStopMetadata) {
    this.onTerminatedEmitter.fire(result);
    this._stopServer();
    this.program = undefined;
  }

  /**
   * Resolves and validates the path to the Node binary as specified in
   * the params.
   */
  protected resolveNodePath(params: T, executable = 'node') {
    return this.pathProvider.resolveAndValidate(
      EnvironmentVars.merge(process.env, this.getConfiguredEnvironment(params)),
      executable,
    );
  }

  /**
   * Returns the user-configured portion of the environment variables.
   */
  protected getConfiguredEnvironment(params: T) {
    let baseEnv = EnvironmentVars.empty;

    // read environment variables from any specified file
    if (params.envFile) {
      try {
        baseEnv = baseEnv.merge(readEnvFile(params.envFile));
      } catch (e) {
        throw new ProtocolError(cannotLoadEnvironmentVars(e.message));
      }
    }

    return baseEnv.merge(params.env);
  }

  /**
   * Gets the environment variables for the session.
   */
  protected resolveEnvironment(
    { params, serverAddress, bootloader }: IRunData<T>,
    callbackFile?: string,
  ) {
    const baseEnv = this.getConfiguredEnvironment(params);
    return baseEnv.merge({
      NODE_INSPECTOR_IPC: serverAddress,
      NODE_INSPECTOR_PPID: '',
      // todo: look at reimplementing the filter
      // NODE_INSPECTOR_WAIT_FOR_DEBUGGER: this._launchParams!.nodeFilter || '',
      NODE_INSPECTOR_WAIT_FOR_DEBUGGER: '',
      // Require our bootloader first, to run it before any other bootloader
      // we could have injected in the parent process.
      NODE_OPTIONS: `--require ${bootloader.path} ${baseEnv.lookup('NODE_OPTIONS') || ''}`,
      // Supply some node executable for running top-level watchdog in Electron
      // environments. Bootloader will replace this with actual node executable used if any.
      NODE_INSPECTOR_EXEC_PATH: findInPath('node', process.env) || '',
      VSCODE_DEBUGGER_FILE_CALLBACK: callbackFile,
      VSCODE_DEBUGGER_ONLY_ENTRYPOINT: params.autoAttachChildProcesses ? 'false' : 'true',
      ELECTRON_RUN_AS_NODE: null,
    });
  }

  /**
   * Logic run when a thread is created.
   */
  protected createLifecycle(
    // eslint-disable-next-line
    _cdp: Cdp.Api,
    // eslint-disable-next-line
    _run: IRunData<T>,
    // eslint-disable-next-line
    _target: Cdp.Target.TargetInfo,
  ): INodeTargetLifecycleHooks {
    return {};
  }

  protected async _startServer(telemetryReporter: TelemetryReporter) {
    const pipePrefix = process.platform === 'win32' ? '\\\\.\\pipe\\' : os.tmpdir();
    const pipe = path.join(pipePrefix, `node-cdp.${process.pid}-${++counter}.sock`);
    const server = await new Promise<net.Server>((resolve, reject) => {
      const s = net
        .createServer(socket => this._startSession(socket, telemetryReporter))
        .on('error', reject)
        .listen(pipe, () => resolve(s));
    });

    return { pipe, server };
  }

  protected _stopServer() {
    if (this.run) {
      this.run.server.close();
      this.run.bootloader.dispose();
    }

    this.run = undefined;
    this.closeAllConnections();
  }

  protected closeAllConnections() {
    this.serverConnections.forEach(c => c.close());
    this.serverConnections = [];
  }

  protected async _startSession(socket: net.Socket, telemetryReporter: TelemetryReporter) {
    const { connection, cdp, targetInfo } = await this.acquireTarget(socket, telemetryReporter);
    if (!this.run) {
      // if we aren't running a session, discard the socket.
      socket.destroy();
      return;
    }

    const target = new NodeTarget(
      this.run.pathResolver,
      this.run.context.targetOrigin,
      connection,
      cdp,
      targetInfo,
      this.createLifecycle(cdp, this.run, targetInfo),
    );

    target.setParent(targetInfo.openerId ? this.targets.get(targetInfo.openerId) : undefined);
    this.targets.add(targetInfo.targetId, target);
    target.onDisconnect(() => this.targets.remove(targetInfo.targetId));
  }

  /**
   * Acquires the CDP session and target info from the connecting socket.
   */

  protected async acquireTarget(socket: net.Socket, rawTelemetryReporter: TelemetryReporter) {
    const connection = new Connection(
      new PipeTransport(this.logger, socket),
      this.logger,
      rawTelemetryReporter,
    );
    this.serverConnections.push(connection);
    const cdp = connection.rootSession();
    const { targetInfo } = await new Promise<Cdp.Target.TargetCreatedEvent>(f =>
      cdp.Target.on('targetCreated', f),
    );

    return { targetInfo, cdp, connection };
  }

  /**
   * Returns the file from which to load our bootloader. We need to do this in
   * since Node does not support paths with spaces in them < 13 (nodejs/node#12971),
   * so if our installation path has spaces, we need to fall back somewhere.
   */
  private getBootloaderFile(cwd: string) {
    const targetPath = path.join(__dirname, 'bootloader.js');

    // 1. If the path doesn't have a space, we're OK to use it.
    if (!targetPath.includes(' ')) {
      return { path: targetPath, dispose: () => undefined };
    }

    // 2. Try the tmpdir, if it's space-free.
    const contents = `require(${JSON.stringify(targetPath)})`;
    if (!os.tmpdir().includes(' ')) {
      const tmpPath = path.join(os.tmpdir(), 'vscode-js-debug-bootloader.js');
      fs.writeFileSync(tmpPath, contents);
      return { path: tmpPath, dispose: () => fs.unlinkSync(tmpPath) };
    }

    // 3. Worst case, write into the cwd. This is messy, but we have few options.
    const nearFilename = '.vscode-js-debug-bootloader.js';
    const nearPath = path.join(cwd, nearFilename);
    fs.writeFileSync(nearPath, contents);
    return { path: `./${nearFilename}`, dispose: () => fs.unlinkSync(nearPath) };
  }
}

function readEnvFile(file: string): { [key: string]: string } {
  if (!fs.existsSync(file)) {
    return {};
  }

  const buffer = stripBOM(fs.readFileSync(file, 'utf8'));
  const env: { [key: string]: string } = {};
  for (const line of buffer.split('\n')) {
    const r = line.match(/^\s*([\w\.\-]+)\s*=\s*(.*)?\s*$/);
    if (!r) {
      continue;
    }

    let value = r[2] || '';
    // .env variables never overwrite existing variables (see #21169)
    if (value.length > 0 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
      value = value.replace(/\\n/gm, '\n');
    }
    env[r[1]] = value.replace(/(^['"]|['"]$)/g, '');
  }

  return env;
}

function stripBOM(s: string): string {
  if (s && s[0] === '\uFEFF') {
    s = s.substr(1);
  }
  return s;
}
