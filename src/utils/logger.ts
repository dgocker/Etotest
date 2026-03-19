export class ClientLogger {
  private static instance: ClientLogger;
  private logs: string[] = [];
  private deviceId: string;
  private flushInterval: number | null = null;

  private constructor() {
    this.deviceId = Math.random().toString(36).substring(2, 10);
    this.startFlushing();
  }

  public static getInstance(): ClientLogger {
    if (!ClientLogger.instance) {
      ClientLogger.instance = new ClientLogger();
    }
    return ClientLogger.instance;
  }

  public log(message: string) {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] ${message}`;
    this.logs.push(formattedMessage);
    console.log(formattedMessage); // Also log to console
  }

  private startFlushing() {
    if (this.flushInterval) return;
    this.flushInterval = window.setInterval(() => {
      this.flush();
    }, 5000); // Flush every 5 seconds
  }

  public async flush() {
    if (this.logs.length === 0) return;

    const logsToSend = [...this.logs];
    this.logs = [];

    try {
      await fetch('/api/logs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          deviceId: this.deviceId,
          logs: logsToSend,
        }),
      });
    } catch (error) {
      console.error('Failed to send logs to server', error);
      // Put them back if failed
      this.logs = [...logsToSend, ...this.logs];
    }
  }

  public downloadLogs() {
    // Download any remaining logs in memory, or fetch from server
    window.open('/api/logs/download?type=client', '_blank');
  }
}

export const logger = ClientLogger.getInstance();
