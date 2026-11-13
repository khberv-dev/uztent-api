import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/guards/jwt-auth.guard.js';
import { CheckUsernameDto } from './dto/check-username.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { UsersService } from './users.service.js';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.usersService.getById(user.id);
  }

  @Get('username-availability')
  async checkUsername(
    @CurrentUser() user: AuthUser,
    @Query() { username }: CheckUsernameDto,
  ) {
    return {
      username,
      available: await this.usersService.isUsernameAvailable(username, user.id),
    };
  }

  @Patch('me')
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateUserDto) {
    return this.usersService.update(user.id, dto);
  }
}
