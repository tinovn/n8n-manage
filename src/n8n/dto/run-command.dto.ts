import { IsNotEmpty, IsString } from 'class-validator';

export class RunCommandDto {
  @IsString()
  @IsNotEmpty()
  cmd: string;
}
