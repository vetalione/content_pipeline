import { Router } from 'express';
import { prisma } from '../lib/db';

export const configRouter = Router();

// Get all style templates
configRouter.get('/templates', async (req, res, next) => {
  try {
    const templates = await prisma.styleTemplate.findMany({
      orderBy: { createdAt: 'desc' }
    });
    
    res.json({ success: true, data: templates });
  } catch (error) {
    next(error);
  }
});

// Get default template
configRouter.get('/templates/default', async (req, res, next) => {
  try {
    const template = await prisma.styleTemplate.findFirst({
      where: { isDefault: true }
    });
    
    res.json({ success: true, data: template });
  } catch (error) {
    next(error);
  }
});

// Create template
configRouter.post('/templates', async (req, res, next) => {
  try {
    const { name, description, config, isDefault } = req.body;
    
    // If setting as default, unset others
    if (isDefault) {
      await prisma.styleTemplate.updateMany({
        where: { isDefault: true },
        data: { isDefault: false }
      });
    }
    
    const template = await prisma.styleTemplate.create({
      data: { name, description, config, isDefault }
    });
    
    res.status(201).json({ success: true, data: template });
  } catch (error) {
    next(error);
  }
});
