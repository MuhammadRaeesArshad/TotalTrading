import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const log = new Logger('bootstrap');

  app.use(helmet());
  app.enableCors({ origin: config.getOrThrow<string[]>('corsOrigins'), credentials: true });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableShutdownHooks();

  const port = config.getOrThrow<number>('port');
  await app.listen(port, '0.0.0.0');
  log.log(`ai-analysis listening on http://localhost:${port}`);
}

void bootstrap();
