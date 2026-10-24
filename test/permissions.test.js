const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { isAdmin, memberRoleIds } = require('../src/bot/permissions');

const MANAGE = PermissionFlagsBits.ManageGuild;
const ADMINISTRATOR = PermissionFlagsBits.Administrator;
const SEND = PermissionFlagsBits.SendMessages;

const cachedMember = (roleIds, permissions = new PermissionsBitField(SEND)) => ({
  roles: { cache: new Map(roleIds.map((id) => [id, { id }])) },
  permissions,
});

describe('memberRoleIds', () => {
  it('reads string[] roles (uncached API member)', () => {
    assert.deepEqual(memberRoleIds({ roles: ['1', '2'] }), ['1', '2']);
  });
  it('reads role manager cache keys', () => {
    assert.deepEqual(memberRoleIds(cachedMember(['7', '8'])), ['7', '8']);
  });
  it('empty for missing member/roles', () => {
    assert.deepEqual(memberRoleIds(null), []);
    assert.deepEqual(memberRoleIds({}), []);
    assert.deepEqual(memberRoleIds({ roles: {} }), []);
  });
});

describe('isAdmin', () => {
  const config = { adminRoleIds: ['r-admin'] };
  it('ManageGuild via PermissionsBitField', () => {
    assert.equal(isAdmin(cachedMember([], new PermissionsBitField(MANAGE)), null), true);
  });
  it('Administrator implies ManageGuild', () => {
    assert.equal(isAdmin(cachedMember([], new PermissionsBitField(ADMINISTRATOR)), null), true);
  });
  it('ManageGuild via raw bitfield string (API member)', () => {
    assert.equal(isAdmin({ roles: [], permissions: String(MANAGE) }, null), true);
    assert.equal(isAdmin({ roles: [], permissions: String(MANAGE | SEND) }, null), true);
    assert.equal(isAdmin({ roles: [], permissions: String(ADMINISTRATOR) }, null), true);
    assert.equal(isAdmin({ roles: [], permissions: String(SEND) }, null), false);
    assert.equal(isAdmin({ roles: [], permissions: '0' }, null), false);
  });
  it('explicit permissions argument (interaction.memberPermissions) overrides member.permissions', () => {
    const m = cachedMember([], new PermissionsBitField(SEND));
    assert.equal(isAdmin(m, null, new PermissionsBitField(MANAGE)), true);
    const boss = cachedMember([], new PermissionsBitField(MANAGE));
    assert.equal(isAdmin(boss, null, new PermissionsBitField(SEND)), false);
  });
  it('configured admin role via role manager', () => {
    assert.equal(isAdmin(cachedMember(['x', 'r-admin']), config), true);
    assert.equal(isAdmin(cachedMember(['x']), config), false);
  });
  it('configured admin role via string[] roles', () => {
    assert.equal(isAdmin({ roles: ['r-admin'], permissions: '0' }, config), true);
    assert.equal(isAdmin({ roles: ['other'], permissions: '0' }, config), false);
  });
  it('no config / empty adminRoleIds -> only ManageGuild counts', () => {
    assert.equal(isAdmin(cachedMember(['r-admin']), null), false);
    assert.equal(isAdmin(cachedMember(['r-admin']), undefined), false);
    assert.equal(isAdmin(cachedMember(['r-admin']), {}), false);
    assert.equal(isAdmin(cachedMember(['r-admin']), { adminRoleIds: [] }), false);
  });
  it('null member and no permissions -> false', () => {
    assert.equal(isAdmin(null, config), false);
    assert.equal(isAdmin(undefined, config), false);
    assert.equal(isAdmin({ roles: ['r-admin'] }, config), true);
  });
});
