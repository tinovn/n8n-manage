import { IsEmail, IsNotEmpty } from 'class-validator';

export class Disable2faDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;
}
