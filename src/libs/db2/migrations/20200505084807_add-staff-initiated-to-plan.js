exports.up = async (knex) => {
  await knex.raw(`
    ALTER TABLE plan
      ADD COLUMN staff_initiated boolean DEFAULT false;
  `);
};

exports.down = async (knex) => {
  await knex.raw(`
    ALTER TABLE plan
      DROP COLUMN staff_initiated;
  `);
};
