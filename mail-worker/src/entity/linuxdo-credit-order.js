import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const linuxdoCreditOrder = sqliteTable('linuxdo_credit_order', {
	outTradeNo: text('out_trade_no').primaryKey(),
	email: text('email').notNull(),
	money: text('money').notNull(),
	name: text('name').notNull(),
	status: text('status').default('pending').notNull(),
	tradeNo: text('trade_no').default('').notNull(),
	tradeStatus: text('trade_status').default('').notNull(),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull(),
	paidTime: text('paid_time'),
	usedTime: text('used_time'),
	isDel: integer('is_del').default(0).notNull()
});

export default linuxdoCreditOrder;
