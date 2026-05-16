import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const linuxdoCreditPendingRegister = sqliteTable('linuxdo_credit_pending_register', {
	outTradeNo: text('out_trade_no').primaryKey(),
	email: text('email').notNull(),
	password: text('password').notNull(),
	salt: text('salt').notNull(),
	regKeyCode: text('reg_key_code').default('').notNull(),
	regKeyId: integer('reg_key_id').default(0).notNull(),
	roleId: integer('role_id').notNull(),
	userId: integer('user_id').default(0).notNull(),
	loginToken: text('login_token').default('').notNull(),
	loginTokenUsed: integer('login_token_used').default(0).notNull(),
	status: text('status').default('pending').notNull(),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull(),
	registeredTime: text('registered_time'),
	isDel: integer('is_del').default(0).notNull()
});

export default linuxdoCreditPendingRegister;
