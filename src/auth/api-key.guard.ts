import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['tng-api-key'];

    const clientIp = request.ip?.startsWith('::ffff:') ? request.ip.substring(7) : request.ip;

    const localIps = ['127.0.0.1', '::1', 'localhost', '172.17.0.1'];
    if (localIps.includes(clientIp)) {
      return true;
    }

    const validApiKey = process.env.AGENT_API_KEY;
    if (!validApiKey) {
      throw new UnauthorizedException('AGENT_API_KEY is not configured.');
    }

    if (apiKey === validApiKey) {
      return true;
    }
    throw new UnauthorizedException('Invalid or missing API Key.');
  }
}
