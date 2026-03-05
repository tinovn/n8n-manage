import { ArrayNotEmpty, IsArray, IsEnum } from 'class-validator';

export enum ExportType {
  Workflows = 'workflow',
  Credentials = 'credentials',
}

export class ExportDataDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(ExportType, { each: true })
  types: ExportType[];
}
