import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';

@Injectable()
export class IpWhitelistGuard implements CanActivate {
  private readonly logger = new Logger(IpWhitelistGuard.name);
  private readonly allowedRanges: string[];

  constructor() {
    const rangesFromEnv = process.env.ALLOWED_IP_RANGES || '';
    const envRanges = rangesFromEnv
      .split(',')
      .map((range) => range.trim())
      .filter(Boolean);

    const defaultIps = [
      '103.130.217.10',
      '103.241.43.235',
      '118.71.120.234',
      '103.130.216.5',
      '103.130.216.58',
      '127.0.0.1',
      '::1',
      '172.17.0.1',
    ];
    this.allowedRanges = [...new Set([...envRanges, ...defaultIps])];

    if (this.allowedRanges.length === 0) {
      this.logger.warn('IP Whitelist is empty. All requests will be blocked.');
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const clientIp = request.ip?.startsWith('::ffff:') ? request.ip.substring(7) : request.ip;

    const localIps = ['127.0.0.1', '::1', 'localhost', '172.17.0.1'];
    if (localIps.includes(clientIp)) {
      this.logger.log(`Bypassing IP check for local IP: ${clientIp}`);
      return true;
    }

    if (clientIp && this.isIpAllowed(clientIp)) {
      return true;
    }
    this.logger.warn(`Request from forbidden or undefined IP blocked: ${clientIp}`);
    throw new ForbiddenException(`IP address ${clientIp ?? 'undefined'} is not allowed.`);
  }

  private isIpAllowed(ip: string): boolean {
    const normalizedIp = ip.startsWith('::ffff:') ? ip.substring(7) : ip;
    for (const range of this.allowedRanges) {
      if (range.includes('/')) {
        if (this.isIpInCidrRange(normalizedIp, range)) {
          return true;
        }
      } else {
        if (normalizedIp === range) {
          return true;
        }
      }
    }
    return false;
  }

  private ipToLong(ip: string): number {
    return (
      ip
        .split('.')
        .reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0
    );
  }

  private isIpInCidrRange(ip: string, cidr: string): boolean {
    try {
      const [range, bitsStr] = cidr.split('/');
      const bits = parseInt(bitsStr, 10);
      const mask = -1 << (32 - bits);
      const ipLong = this.ipToLong(ip);
      const rangeLong = this.ipToLong(range);
      return (ipLong & mask) === (rangeLong & mask);
    } catch (e) {
      this.logger.error(`Invalid CIDR format: ${cidr}`);
      return false;
    }
  }
}
