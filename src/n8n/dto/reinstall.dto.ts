import { IsEmail, IsNotEmpty } from 'class-validator';

export class ReinstallDto {
  @IsNotEmpty()
  domain: string;

  @IsEmail()
  @IsNotEmpty()
  email: string;
}
