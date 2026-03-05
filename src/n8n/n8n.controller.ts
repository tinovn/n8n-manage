import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  ConflictException,
  NotFoundException,
  Patch,
  Post,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ChangeDomainDto } from './dto/change-domain.dto';
import { Disable2faDto } from './dto/disable-2fa.dto';
import { ExportDataDto } from './dto/export-data.dto';
import { ImportDataDto } from './dto/import-data.dto';
import { InstallN8nDto } from './dto/install-n8n.dto';
import { ReinstallDto } from './dto/reinstall.dto';
import { UpdateVersionDto } from './dto/update-version.dto';
import { RunCommandDto } from './dto/run-command.dto';
import { N8nService } from './n8n.service';

@Controller('api/n8n')
export class N8nController {
  constructor(private readonly n8nService: N8nService) {}

  @Post('install')
  @HttpCode(HttpStatus.ACCEPTED)
  install(@Body() installDto: InstallN8nDto) {
    try {
      const taskId = this.n8nService.install(installDto.domain, installDto.email);
      return {
        statusCode: HttpStatus.ACCEPTED,
        message: 'Installation process has been accepted.',
        taskId,
      };
    } catch (error) {
      if (error instanceof ConflictException) throw new ConflictException(error.message);
      throw new InternalServerErrorException(`Failed to initiate installation: ${error.message}`);
    }
  }

  @Delete()
  @HttpCode(HttpStatus.ACCEPTED)
  delete() {
    try {
      const taskId = this.n8nService.delete();
      return {
        statusCode: HttpStatus.ACCEPTED,
        message: 'Deletion process has been accepted.',
        taskId,
      };
    } catch (error) {
      if (error instanceof ConflictException) throw new ConflictException(error.message);
      throw new InternalServerErrorException(`Failed to initiate deletion: ${error.message}`);
    }
  }

  @Post('reinstall')
  @HttpCode(HttpStatus.ACCEPTED)
  reinstall(@Body() reinstallDto: ReinstallDto) {
    try {
      const taskId = this.n8nService.reinstall(reinstallDto.domain, reinstallDto.email);
      return {
        statusCode: HttpStatus.ACCEPTED,
        message: 'Reinstallation process has been accepted.',
        taskId,
      };
    } catch (error) {
      if (error instanceof ConflictException) throw new ConflictException(error.message);
      throw new InternalServerErrorException(
        `Failed to initiate reinstallation: ${error.message}`,
      );
    }
  }

  @Patch('change-domain')
  @HttpCode(HttpStatus.ACCEPTED)
  changeDomain(@Body() changeDomainDto: ChangeDomainDto) {
    try {
      const taskId = this.n8nService.changeDomain(
        changeDomainDto.newDomain,
        changeDomainDto.newEmail,
        changeDomainDto.ip,
      );
      return {
        statusCode: HttpStatus.ACCEPTED,
        message: 'Domain change process has been accepted.',
        taskId,
      };
    } catch (error) {
      if (error instanceof ConflictException) throw new ConflictException(error.message);
      throw new InternalServerErrorException(
        `Failed to initiate domain change: ${error.message}`,
      );
    }
  }

  @Post('reset-owner')
  @HttpCode(HttpStatus.ACCEPTED)
  resetOwner() {
    try {
      const taskId = this.n8nService.resetOwner();
      return {
        statusCode: HttpStatus.ACCEPTED,
        message: 'Owner reset process has been accepted.',
        taskId,
      };
    } catch (error) {
      if (error instanceof ConflictException) throw new ConflictException(error.message);
      throw new InternalServerErrorException(`Failed to initiate owner reset: ${error.message}`);
    }
  }

  @Post('disable-2fa')
  @HttpCode(HttpStatus.ACCEPTED)
  disable2FA(@Body() disable2faDto: Disable2faDto) {
    try {
      const taskId = this.n8nService.disable2FA(disable2faDto.email);
      return {
        statusCode: HttpStatus.ACCEPTED,
        message: `2FA disable process for user '${disable2faDto.email}' has been accepted.`,
        taskId,
      };
    } catch (error) {
      if (error instanceof ConflictException) throw new ConflictException(error.message);
      throw new InternalServerErrorException(`Failed to initiate 2FA disable: ${error.message}`);
    }
  }

  @Post('upgrade')
  @HttpCode(HttpStatus.ACCEPTED)
  upgrade() {
    try {
      const taskId = this.n8nService.upgrade();
      return {
        statusCode: HttpStatus.ACCEPTED,
        message: 'Upgrade process to latest has been accepted.',
        taskId,
      };
    } catch (error) {
      if (error instanceof ConflictException) throw new ConflictException(error.message);
      throw new InternalServerErrorException(`Failed to initiate upgrade: ${error.message}`);
    }
  }

  @Get('version')
  @HttpCode(HttpStatus.OK)
  async getVersionInfo() {
    try {
      const versionInfo = await this.n8nService.getVersionInfo();
      return {
        statusCode: HttpStatus.OK,
        message: 'Successfully retrieved version info.',
        data: versionInfo,
      };
    } catch (error) {
      if (error instanceof ConflictException) throw new ConflictException(error.message);
      throw new InternalServerErrorException(`Failed to get version info: ${error.message}`);
    }
  }

  @Post('version/update')
  @HttpCode(HttpStatus.ACCEPTED)
  updateToVersion(@Body() updateVersionDto: UpdateVersionDto) {
    try {
      const taskId = this.n8nService.updateToVersion(updateVersionDto.version);
      return {
        statusCode: HttpStatus.ACCEPTED,
        message: `Update process to version ${updateVersionDto.version} has been accepted.`,
        taskId,
      };
    } catch (error) {
      if (error instanceof ConflictException) throw new ConflictException(error.message);
      throw new InternalServerErrorException(
        `Failed to initiate version update: ${error.message}`,
      );
    }
  }

  @Post('run-command')
  @HttpCode(HttpStatus.ACCEPTED)
  async runCommand(@Body() runCommandDataDto: RunCommandDto) {
    try {
      const taskId = this.n8nService.runCommand(runCommandDataDto.cmd);
      return {
        statusCode: HttpStatus.ACCEPTED,
        message: `Update process to command ${runCommandDataDto.cmd} has been accepted.`,
        taskId,
      };
    } catch (error) {
      if (error instanceof ConflictException) throw new ConflictException(error.message);
      throw new InternalServerErrorException(`Failed to initiate run command: ${error.message}`);
    }
  }

  @Post('export')
  @HttpCode(HttpStatus.OK)
  async exportData(@Body() exportDataDto: ExportDataDto, @Res({ passthrough: true }) res: Response) {
    try {
      const { stream, filename } = await this.n8nService.exportData(exportDataDto.types);
      res.set({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
      return stream;
    } catch (error) {
      if (error instanceof ConflictException) throw new ConflictException(error.message);
      throw new InternalServerErrorException(`Export failed: ${error.message}`);
    }
  }

  @Post('import')
  @UseInterceptors(FilesInterceptor('files', 200))
  @HttpCode(HttpStatus.OK)
  async importData(
    @UploadedFiles() files: Express.Multer.File[],
    @Body() importDataDto: ImportDataDto,
  ) {
    if (!files || files.length === 0) {
      throw new InternalServerErrorException('At least one JSON file is required for import.');
    }
    try {
      const result = await this.n8nService.importData(files, importDataDto.overwrite);
      return {
        statusCode: HttpStatus.OK,
        message: 'Import process has been completed.',
        data: result,
      };
    } catch (error) {
      if (error instanceof ConflictException) throw new ConflictException(error.message);
      throw new InternalServerErrorException(`Import failed: ${error.message}`);
    }
  }

  @Get('redis-info')
  @HttpCode(HttpStatus.OK)
  async getRedisInfo() {
    try {
      const redisInfo = await this.n8nService.getRedisInfo();
      return {
        statusCode: HttpStatus.OK,
        message: 'Successfully retrieved Redis info.',
        data: redisInfo,
      };
    } catch (error) {
      if (error instanceof ConflictException) throw new ConflictException(error.message);
      throw new InternalServerErrorException(`Failed to get Redis info: ${error.message}`);
    }
  }

  @Get('nocodb-info')
  @HttpCode(HttpStatus.OK)
  async getNocodbInfo() {
    try {
      const nocodbInfo = await this.n8nService.getNocodbInfo();
      return {
        statusCode: HttpStatus.OK,
        message: 'Successfully retrieved Nocodb info.',
        data: nocodbInfo,
      };
    } catch (error) {
      if (error instanceof ConflictException) throw new ConflictException(error.message);
      throw new InternalServerErrorException(`Failed to get NocoDB info: ${error.message}`);
    }
  }

  @Get('status')
  @HttpCode(HttpStatus.OK)
  async getStatus() {
    try {
      const statusInfo = await this.n8nService.status();
      return {
        statusCode: HttpStatus.OK,
        message: 'Successfully retrieved instance status.',
        data: statusInfo,
      };
    } catch (error) {
      if (error instanceof ConflictException) throw new ConflictException(error.message);
      throw new InternalServerErrorException(`Failed to get status: ${error.message}`);
    }
  }

  @Get('info')
  @HttpCode(HttpStatus.OK)
  async getInfo() {
    try {
      const instanceInfo = await this.n8nService.info();
      return {
        statusCode: HttpStatus.OK,
        message: 'Successfully retrieved instance information.',
        data: instanceInfo,
      };
    } catch (error) {
      if (error instanceof ConflictException) throw new ConflictException(error.message);
      throw new InternalServerErrorException(`Failed to get info: ${error.message}`);
    }
  }

  @Get('export-summary')
  @HttpCode(HttpStatus.OK)
  async getExportSummary() {
    try {
      const summary = await this.n8nService.getExportSummary();
      return {
        statusCode: HttpStatus.OK,
        message: 'Successfully retrieved export summary.',
        data: summary,
      };
    } catch (error) {
      if (error instanceof ConflictException || error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException(`Failed to get export summary: ${error.message}`);
    }
  }
}
