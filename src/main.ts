import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as dotenv from 'dotenv';
import { AppModule } from './app.module';
import { ApiKeyGuard } from './auth/api-key.guard';
import { IpWhitelistGuard } from './auth/ip-whitelist.guard';

async function bootstrap() {
  dotenv.config();
  const app = await NestFactory.create(AppModule);
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set('trust proxy', 1);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: 'Content-Type, Authorization, tng-api-key',
  });
  app.useGlobalGuards(new IpWhitelistGuard(), new ApiKeyGuard());
  await app.listen(process.env.PORT ?? 7071);
}
bootstrap();
